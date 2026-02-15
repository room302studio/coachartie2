/**
 * Artie's Wallet Capability
 *
 * Gives Artie financial agency on Ethereum/Base.
 *
 * Actions:
 * - balance: Check wallet balance across networks
 * - send: Send ETH or tokens (with daily limits)
 * - sign: Sign messages (for x402, etc.)
 * - address: Show wallet address
 */

import { ethers } from 'ethers';
import { logger } from '@coachartie/shared';
import * as fs from 'fs';
import type { RegisteredCapability, CapabilityContext } from '../../services/capability/capability-registry.js';

// Wallet config
const WALLET_PATH = '/home/debian/.artie-wallet/wallet.json';
const DAILY_LIMIT_USD = 10; // Start conservative

// Network configs
const NETWORKS: Record<string, { rpc: string; name: string; chainId: number; usdc?: string }> = {
  ethereum: {
    rpc: 'https://eth.llamarpc.com',
    name: 'Ethereum Mainnet',
    chainId: 1,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  base: {
    rpc: 'https://mainnet.base.org',
    name: 'Base',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// Base bridge contract on Ethereum mainnet
const BASE_BRIDGE_ADDRESS = '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e';
const BASE_BRIDGE_ABI = [
  'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable',
];

// Daily spending tracker
interface SpendingTracker {
  date: string;
  spent: number;
}
let dailySpending: SpendingTracker = { date: '', spent: 0 };

function loadWallet(): { address: string; privateKey: string } | null {
  try {
    const data = fs.readFileSync(WALLET_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function checkDailyLimit(amountUsd: number): boolean {
  const today = new Date().toISOString().split('T')[0];
  if (dailySpending.date !== today) {
    dailySpending = { date: today, spent: 0 };
  }
  return (dailySpending.spent + amountUsd) <= DAILY_LIMIT_USD;
}

function recordSpending(amountUsd: number): void {
  const today = new Date().toISOString().split('T')[0];
  if (dailySpending.date !== today) {
    dailySpending = { date: today, spent: 0 };
  }
  dailySpending.spent += amountUsd;
}

interface WalletParams {
  action: string;
  network?: string;
  to?: string;
  amount?: string;
  token?: string;
  message?: string;
  [key: string]: unknown;
}

async function handleWallet(
  params: WalletParams,
  _content?: string,
  _ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const walletData = loadWallet();

  if (!walletData) {
    return 'Wallet not configured. No wallet.json found.';
  }

  const networkKey = (params.network || 'ethereum').toLowerCase();
  const network = NETWORKS[networkKey];

  if (!network && action !== 'balance') {
    return `Unknown network: ${networkKey}. Available: ${Object.keys(NETWORKS).join(', ')}`;
  }

  logger.info(`Wallet action: ${action} on ${networkKey}`);

  try {
    switch (action) {
      case 'balance': {
        const lines: string[] = ["**Artie's Wallet**", '', `Address: \`${walletData.address}\``, ''];

        for (const [key, net] of Object.entries(NETWORKS)) {
          try {
            const provider = new ethers.JsonRpcProvider(net.rpc);
            const ethBal = await provider.getBalance(walletData.address);
            const ethAmount = parseFloat(ethers.formatEther(ethBal));

            let usdcAmount = 0;
            if (net.usdc) {
              try {
                const usdc = new ethers.Contract(net.usdc, ERC20_ABI, provider);
                const usdcBal = await usdc.balanceOf(walletData.address);
                usdcAmount = parseFloat(ethers.formatUnits(usdcBal, 6));
              } catch {
                // USDC check failed, continue
              }
            }

            const hasBalance = ethAmount > 0.00001 || usdcAmount > 0.01;
            if (hasBalance) {
              lines.push(`**${net.name}**:`);
              if (ethAmount > 0.00001) lines.push(`  ETH: ${ethAmount.toFixed(6)}`);
              if (usdcAmount > 0.01) lines.push(`  USDC: $${usdcAmount.toFixed(2)}`);
              lines.push('');
            }
          } catch {
            // Skip failed networks
          }
        }

        // Daily spending info
        const today = new Date().toISOString().split('T')[0];
        if (dailySpending.date === today) {
          lines.push(`Daily spending: $${dailySpending.spent.toFixed(2)} / $${DAILY_LIMIT_USD}`);
        } else {
          lines.push(`Daily limit: $${DAILY_LIMIT_USD} (unused today)`);
        }

        return lines.join('\n');
      }

      case 'send': {
        const { to, amount, token } = params;
        if (!to || !amount) {
          return 'Need `to` address and `amount`';
        }

        if (!ethers.isAddress(to)) {
          return `Invalid address: ${to}`;
        }

        const amountNum = parseFloat(amount);
        // Rough USD estimate (assuming ETH ~ $2000)
        const estimatedUsd = token === 'usdc' ? amountNum : amountNum * 2000;

        if (!checkDailyLimit(estimatedUsd)) {
          return `Would exceed daily limit of $${DAILY_LIMIT_USD}. Already spent: $${dailySpending.spent.toFixed(2)}`;
        }

        const provider = new ethers.JsonRpcProvider(network.rpc);
        const wallet = new ethers.Wallet(walletData.privateKey, provider);

        let tx;
        if (token === 'usdc' && network.usdc) {
          const usdc = new ethers.Contract(network.usdc, ERC20_ABI, wallet);
          const amountWei = ethers.parseUnits(amount, 6);
          tx = await usdc.transfer(to, amountWei);
        } else {
          tx = await wallet.sendTransaction({
            to,
            value: ethers.parseEther(amount),
          });
        }

        recordSpending(estimatedUsd);

        return `Transaction sent!\n\nTo: ${to}\nAmount: ${amount} ${token || 'ETH'}\nTx: ${tx.hash}\n\nWaiting for confirmation...`;
      }

      case 'sign': {
        const { message } = params;
        if (!message) {
          return 'Need `message` to sign';
        }

        const wallet = new ethers.Wallet(walletData.privateKey);
        const signature = await wallet.signMessage(message);

        return `Message signed\n\nMessage: ${message}\nSignature: ${signature}`;
      }

      case 'address': {
        return `**Artie's Wallet Address**\n\n\`${walletData.address}\`\n\nSend ETH or USDC on Ethereum or Base.`;
      }

      case 'bridge': {
        const { amount } = params;
        if (!amount) {
          return 'Need `amount` of ETH to bridge to Base';
        }

        const amountNum = parseFloat(amount);
        const estimatedUsd = amountNum * 2000;

        // Check we have enough on mainnet
        const mainnetProvider = new ethers.JsonRpcProvider(NETWORKS.ethereum.rpc);
        const balance = await mainnetProvider.getBalance(walletData.address);
        const balanceEth = parseFloat(ethers.formatEther(balance));

        if (balanceEth < amountNum + 0.001) {
          return `Insufficient balance. Have ${balanceEth.toFixed(6)} ETH, need ${amountNum} + gas`;
        }

        if (!checkDailyLimit(estimatedUsd)) {
          return `Would exceed daily limit of $${DAILY_LIMIT_USD}. Already spent: $${dailySpending.spent.toFixed(2)}`;
        }

        const wallet = new ethers.Wallet(walletData.privateKey, mainnetProvider);
        const bridge = new ethers.Contract(BASE_BRIDGE_ADDRESS, BASE_BRIDGE_ABI, wallet);

        // Bridge ETH to Base (same address on L2)
        const gasLimit = 100000n;
        const tx = await bridge.depositTransaction(
          walletData.address,
          ethers.parseEther(amount),
          gasLimit,
          false,
          '0x',
          { value: ethers.parseEther(amount) }
        );

        recordSpending(estimatedUsd);

        return `Bridging ${amount} ETH to Base!\n\nTx: ${tx.hash}\n\nETH will arrive on Base in ~10-20 minutes.\nTrack at: https://etherscan.io/tx/${tx.hash}`;
      }

      default:
        return `Unknown wallet action: ${action}. Try: balance, send, sign, address, bridge`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Wallet error:', err);
    return `Wallet error: ${msg}`;
  }
}

export const walletCapability: RegisteredCapability = {
  name: 'wallet',
  emoji: '💰',
  description: `Artie's crypto wallet for autonomous transactions.
- balance: Check balances across networks
- send: Send ETH or USDC (daily limit: $${DAILY_LIMIT_USD})
- sign: Sign messages for authentication
- address: Show wallet address
- bridge: Bridge ETH from Ethereum to Base (lower fees)`,
  supportedActions: ['balance', 'send', 'sign', 'address', 'bridge'],
  handler: handleWallet,
};

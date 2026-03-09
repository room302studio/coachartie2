import { ethers } from 'ethers';

const ARTIE_ADDRESS = '0x8ca80568D9B83689A461832844Efe6a13626411B';

// Base mainnet RPC
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

// USDC on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

async function checkBalance() {
  console.log("Checking Artie's wallet on Base...\n");
  console.log("Address:", ARTIE_ADDRESS);
  console.log("");
  
  // ETH balance
  const ethBalance = await provider.getBalance(ARTIE_ADDRESS);
  console.log("ETH:", ethers.formatEther(ethBalance), "ETH");
  
  // USDC balance
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdcBalance = await usdc.balanceOf(ARTIE_ADDRESS);
  const decimals = await usdc.decimals();
  console.log("USDC:", ethers.formatUnits(usdcBalance, decimals), "USDC");
  
  console.log("\n=== Artie's Treasury ===");
}

checkBalance().catch(console.error);

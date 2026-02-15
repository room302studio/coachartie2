/**
 * Pairing Capability
 *
 * OpenClaw-compatible DM pairing management.
 * Allows the owner to approve, deny, and manage DM access requests.
 */

import { logger, dmPairingService, isOwner } from '@coachartie/shared';
import type { RegisteredCapability, CapabilityContext } from '../../services/capability/capability-registry.js';

interface PairingParams {
  action: string;
  code?: string;
  userId?: string;
  platform?: string;
  policy?: 'pairing' | 'open' | 'closed';
  reason?: string;
  [key: string]: unknown;
}

async function handlePairing(
  params: PairingParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const callerId = ctx?.userId;

  // Only owner can manage pairing
  if (!callerId || !isOwner(callerId)) {
    return 'Only the owner can manage DM pairing.';
  }

  const platform = params.platform || 'discord';
  const code = params.code || content;

  logger.info(`Pairing - Action: ${action}, Code: ${code}, Platform: ${platform}`);

  try {
    switch (action) {
      case 'approve': {
        if (!code) {
          return 'Please provide a pairing code to approve.';
        }

        const result = dmPairingService.approve(code, callerId, params.reason);
        if (result.success) {
          const userDisplay = result.username ? `${result.username} (${result.userId})` : result.userId;
          return `✅ Approved! ${userDisplay} can now DM me.`;
        }
        return `❌ ${result.error}`;
      }

      case 'deny': {
        if (!code) {
          return 'Please provide a pairing code to deny.';
        }

        const result = dmPairingService.deny(code, callerId);
        if (result.success) {
          return `✅ Denied pairing code ${code}.`;
        }
        return `❌ ${result.error}`;
      }

      case 'revoke': {
        const userId = params.userId || code;
        if (!userId) {
          return 'Please provide a user ID to revoke.';
        }

        const result = dmPairingService.revoke(platform, userId, callerId);
        if (result.success) {
          return `✅ Revoked DM access for ${userId}.`;
        }
        return `❌ ${result.error}`;
      }

      case 'add': {
        const userId = params.userId || code;
        if (!userId) {
          return 'Please provide a user ID to add.';
        }

        dmPairingService.addToAllowlist(platform, userId, null, callerId, params.reason);
        return `✅ Added ${userId} to DM allowlist.`;
      }

      case 'pending':
      case 'list-pending': {
        const pending = dmPairingService.listPending(platform);
        if (pending.length === 0) {
          return 'No pending pairing requests.';
        }

        const list = pending.map(p => {
          const expiresIn = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60000));
          const preview = p.firstMessage ? `\n   > "${p.firstMessage.slice(0, 80)}${p.firstMessage.length > 80 ? '...' : ''}"` : '';
          return `- **${p.code}** - ${p.username || p.userId} (expires in ${expiresIn}m)${preview}`;
        }).join('\n');

        return `**Pending Pairing Requests (${pending.length})**\n\n${list}\n\nUse \`pairing approve <code>\` to approve.`;
      }

      case 'allowed':
      case 'list':
      case 'allowlist': {
        const allowed = dmPairingService.listAllowed(platform);
        if (allowed.length === 0) {
          return 'No users on the DM allowlist.';
        }

        const list = allowed.map(a => {
          const approvedDate = new Date(a.approvedAt).toLocaleDateString();
          return `- ${a.username || a.userId} (approved ${approvedDate})`;
        }).join('\n');

        return `**DM Allowlist (${allowed.length})**\n\n${list}\n\nUse \`pairing revoke <userId>\` to remove.`;
      }

      case 'policy': {
        if (params.policy) {
          dmPairingService.setPolicy(platform, params.policy);
          return `✅ DM policy for ${platform} set to: **${params.policy}**`;
        }

        const currentPolicy = dmPairingService.getPolicy(platform);
        return `**DM Policy for ${platform}**

Policy: **${currentPolicy.policy}**
Code Expiry: ${currentPolicy.codeExpiryMinutes} minutes

**Policy Modes:**
- \`pairing\` (default): Unknown users get pairing code, you approve
- \`open\`: Anyone can DM (public bot)
- \`closed\`: Only allowlist, no pairing codes

Set with: \`pairing policy <mode>\``;
      }

      case 'status': {
        const policy = dmPairingService.getPolicy(platform);
        const pending = dmPairingService.listPending(platform);
        const allowed = dmPairingService.listAllowed(platform);

        return `**DM Pairing Status**

Platform: ${platform}
Policy: **${policy.policy}**
Pending Requests: ${pending.length}
Allowed Users: ${allowed.length}

Use \`pairing pending\` to see requests.
Use \`pairing allowed\` to see allowlist.`;
      }

      case 'help':
      default: {
        return `**DM Pairing Management**

OpenClaw-compatible DM access control.

**Commands:**
- \`pairing approve <code>\` - Approve a pairing request
- \`pairing deny <code>\` - Deny a pairing request
- \`pairing revoke <userId>\` - Revoke DM access
- \`pairing add <userId>\` - Add user directly (bypass pairing)
- \`pairing pending\` - List pending requests
- \`pairing allowed\` - List allowed users
- \`pairing policy [mode]\` - View/set DM policy
- \`pairing status\` - Overview

**Policy Modes:**
- \`pairing\`: Unknown users get 6-digit code (default)
- \`open\`: Anyone can DM
- \`closed\`: Allowlist only, no codes`;
      }
    }
  } catch (error) {
    logger.error('Pairing error:', error);
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const pairingCapability: RegisteredCapability = {
  name: 'pairing',
  emoji: '🔐',
  supportedActions: ['approve', 'deny', 'revoke', 'add', 'pending', 'list-pending', 'allowed', 'list', 'allowlist', 'policy', 'status', 'help'],
  description: `OpenClaw-compatible DM pairing management. Actions:
- approve <code>: Approve a DM pairing request
- deny <code>: Deny a pairing request
- revoke <userId>: Remove someone's DM access
- add <userId>: Add user directly to allowlist
- pending: List pending pairing requests
- allowed: List users on the allowlist
- policy [mode]: View or set DM policy (pairing/open/closed)
- status: Overview of DM pairing system`,
  handler: handlePairing,
};

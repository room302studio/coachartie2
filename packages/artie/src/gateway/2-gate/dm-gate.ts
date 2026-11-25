/**
 * DM gate: who may DM Artie. Owner and allowed users pass; under the 'pairing' policy an
 * unknown user gets a pairing code (and EJ an anomalywatch page for a new request); under
 * 'closed' the DM is ignored; 'open' lets everyone through. Moved verbatim out of
 * on-message.ts (wave 5).
 */

import type { Message } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { canDMForTasks, getDMPolicy, isOwner } from '../../shared/config/owner.js';
import { dmPairingService, logDMGate } from '../../shared/dm-pairing.js';
import { reportToAnomalywatch } from '../../shared/anomalywatch.js';
import { telemetry } from '../telemetry.js';
import type { ResponseConditions } from './ambient.js';

type DMGateVerdict = { stop: true } | { stop: false; isDMAllowed: boolean };

/** stop: the DM was answered with a pairing code or ignored; otherwise whether it may proceed. */
export async function runDMGate(
  message: Message,
  responseConditions: ResponseConditions,
  correlationId: string,
  shortId: string
): Promise<DMGateVerdict> {
  // For DMs, check authorization via pairing system
  // OpenClaw-compatible: unknown users get pairing code
  const isDMFromAuthorizedUser = responseConditions.isDM && canDMForTasks(message.author.id);
  const dmWho = { userId: message.author.id, username: message.author.username };

  if (isDMFromAuthorizedUser) {
    let gateLevel: 'owner' | 'allowed';
    if (isOwner(message.author.id)) {
      gateLevel = 'owner';
    } else {
      gateLevel = 'allowed';
    }
    logDMGate(gateLevel, { ...dmWho, detail: `[${shortId}]` });
  }

  if (responseConditions.isDM && !isDMFromAuthorizedUser) {
    const policy = getDMPolicy('discord');

    if (policy.policy === 'open') {
      // Open mode: treat as authorized
      logDMGate('open', { ...dmWho, detail: `open policy [${shortId}]` });
    } else if (policy.policy === 'pairing') {
      // Pairing mode: send pairing code
      logDMGate('blocked_pairing', {
        ...dmWho,
        // No message text: this goes to logs (Loki). The pairing alert to EJ below quotes it.
        detail: `unverified, sent pairing code (${message.content.length} chars) [${shortId}]`,
      });

      try {
        const { code, expiresAt, isNew } = dmPairingService.getOrCreatePairingCode(
          'discord',
          message.author.id,
          message.author.username,
          message.content
        );

        const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000);
        const pairingMessage = dmPairingService.generatePairingMessage('discord', code, expiresInMinutes);

        await message.reply(pairingMessage);
        telemetry.logEvent('dm_pairing_code_sent', { userId: message.author.id, isNew }, correlationId, message.author.id);

        // New request → EJ's phone via anomalywatch (EJ, 2026-09-29: "run it thru anomalywatch
        // at a high weight"). Its own alert_type scores 7.5 there: pages when awake, digest
        // when asleep. One per requester per ET day, so a stranger can't spam pages.
        if (isNew) {
          void reportToAnomalywatch(
            'warning',
            `DM pairing request: ${message.author.username} (${message.author.id}) wants to DM Artie: "${message.content.slice(0, 120)}". Approve with /pairing approve code:${code} (expires in ${expiresInMinutes}m)`,
            {
              kind: `dm-pairing:${message.author.id}`,
              alertType: 'dm_pairing_request',
              deepLink: `https://discord.com/users/${message.author.id}`,
            }
          );
        }
      } catch (error) {
        logger.error('Failed to send pairing code:', error);
      }

      return { stop: true }; // Don't process the message further
    } else {
      // Closed mode: silent ignore (current behavior)
      logDMGate('blocked_closed', { ...dmWho, detail: `closed policy, ignored [${shortId}]` });
      return { stop: true };
    }
  }

  // Check if DM should be processed (authorized OR open policy)
  let dmPolicy: ReturnType<typeof getDMPolicy> | null;
  if (responseConditions.isDM) {
    dmPolicy = getDMPolicy('discord');
  } else {
    dmPolicy = null;
  }
  const isDMAllowed = isDMFromAuthorizedUser || (responseConditions.isDM && dmPolicy?.policy === 'open');
  return { stop: false, isDMAllowed };
}

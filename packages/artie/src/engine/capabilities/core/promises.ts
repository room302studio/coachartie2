import { RegisteredCapability } from '../registry.js';
import { isOwner } from '../../../shared/config/owner.js';
import {
  MAX_PROMISE_CHARS,
  PROMISE_WINDOW_DAYS,
  addPromise,
  getPromise,
  listOpenPromises,
  resolvePromise,
  waitNote,
  withApprovalStatus,
  type PromiseView,
} from '../../../shared/db/promise-store.js';
import { getPendingAction } from '../../../shared/pending-actions.js';

// =====================================================
// PROMISES: what Artie told someone he'd do (Artie's request, 2026-11-17).
// Always to the person asking; where it was made comes from the conversation, never params.
// Open ones show on that person's "last time" line (3-context/sources/last-time.ts).
// =====================================================

function parseId(raw: unknown): number | null {
  const m = /^p?(\d+)$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  return Number(m[1]);
}

function age(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function formatPromise(p: PromiseView, now: number): string {
  let wait = waitNote(p.waits_on, p.waitStatus);
  if (wait) wait = `; ${wait}`;
  return `P${p.id} ${p.text} (${age(p.created_at, now)}${wait})`;
}

export const promisesCapability: RegisteredCapability = {
  name: 'promises',
  emoji: '🤝',
  actions: {
    add: {
      effect: 'own',
      params: {
        text: {
          type: 'string',
          description: `What you said you'd do, short (max ${MAX_PROMISE_CHARS} chars), e.g. "check on their map once the tiles render"`,
          required: true,
          aliases: ['promise', 'what'],
        },
        waits_on: {
          type: 'string',
          description:
            'Optional approval id this waits on, e.g. #12 (one THIS person asked for). The promise then shows whether EJ approved, denied or let it expire.',
          aliases: ['approval', 'approval_id'],
        },
      },
    },
    list: { effect: 'read' },
    done: {
      effect: 'own',
      params: { id: { type: 'string', description: 'Promise id, e.g. P3', required: true, aliases: ['promise_id'] } },
    },
    drop: {
      effect: 'own',
      params: { id: { type: 'string', description: 'Promise id, e.g. P3', required: true, aliases: ['promise_id'] } },
    },
  },
  supportedActions: ['add', 'list', 'done', 'drop'],
  description:
    `Use when you tell the person you're talking to that you'll do something later without a set time ("I'll check on your map", "I'll follow up", "I'll ping you once EJ approves"): record it with add in that same turn. Open promises show up next time they talk to you; close them with done (you did it) or drop (no longer needed, say so). Only promises to the person asking. For a specific time use scheduler instead. Open ones older than ${PROMISE_WINDOW_DAYS} days stop showing.`,
  handler: async (params, _content, context) => {
    const action = String(params.action ?? '');
    const callerId = context?.userId;
    if (!callerId) {
      return "❌ I can't tell who I'm talking to here, so I can't track a promise.";
    }
    const guildId = context?.guildId ?? null;
    const now = Date.now();

    switch (action) {
      case 'add': {
        let waitsOn: number | null = null;
        const rawWait = String(params.waits_on ?? '').trim();
        if (rawWait) {
          const m = /^#?(\d+)$/.exec(rawWait);
          // Only an approval this person asked for (or anything, for the owner): the promise
          // line reveals the approval's outcome, which isn't anyone else's to see.
          let approval = null;
          if (m) approval = getPendingAction(Number(m[1]));
          if (!m || !approval || (approval.requestedBy !== callerId && !isOwner(callerId))) {
            return `❌ I don't see an approval ${rawWait} requested by this person. Check approvals list, or leave waits_on out.`;
          }
          waitsOn = approval.id;
        }
        const result = addPromise(
          {
            userId: callerId,
            guildId,
            channelId: context?.channelId ?? null,
            text: String(params.text ?? ''),
            waitsOn,
          },
          now
        );
        if (!result.ok) return `❌ ${result.error}`;
        const [view] = withApprovalStatus([result.row]);
        return `✅ Noted promise ${formatPromise(view, now)}. It'll show up when they talk to you next; mark it done when you've done it.`;
      }

      case 'list': {
        const open = withApprovalStatus(listOpenPromises(callerId, guildId, now));
        if (open.length === 0) return '📋 No open promises to this person here.';
        return `📋 Open promises (${open.length}):\n${open.map((p) => `• ${formatPromise(p, now)}`).join('\n')}`;
      }

      case 'done':
      case 'drop': {
        const id = parseId(params.id);
        if (id === null) throw new Error('id is required, e.g. P3');
        const row = getPromise(id);
        // Same answer for "no such id" and "someone else's": don't confirm other people's ids.
        // In a server, only promises made in that server (a DM one is private to that DM).
        // The scope rule binds the owner too: closing echoes the text, so a DM promise must
        // never be closable (and printed) from inside a server.
        let visible = false;
        if (row && row.status === 'open') {
          const whose = row.user_id === callerId || isOwner(callerId);
          const sameScope = (guildId === null && row.user_id === callerId) || (guildId !== null && row.guild_id === guildId);
          visible = whose && sameScope;
        }
        if (!row || !visible) return `❌ I don't see an open promise P${id} of yours here.`;
        let status: 'done' | 'dropped' = 'done';
        if (action === 'drop') status = 'dropped';
        if (!resolvePromise(id, status, now)) {
          return `❌ P${id} was already closed.`;
        }
        let verb = 'done';
        if (status === 'dropped') verb = 'dropped';
        return `✅ P${id} ${verb}: "${row.text}"`;
      }

      default:
        throw new Error(`Unknown promises action: ${action}`);
    }
  },
};

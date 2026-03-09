/**
 * Kanban Capability
 *
 * Gives Artie access to the shared kanban board at kanban.tools.ejfox.com
 * This is the same board VPS Claude uses for autonomous task tracking.
 *
 * Enables cross-agent coordination:
 * - Artie can see what VPS Claude is working on
 * - Artie can create tasks for VPS Claude
 * - Artie can update task status based on conversations
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

const KANBAN_URL = 'https://kanban.tools.ejfox.com/api';

import { readFileSync } from 'fs';

// Try to get token from environment or file
function getToken(): string | null {
  if (process.env.KANBAN_TOKEN) {
    return process.env.KANBAN_TOKEN;
  }
  try {
    const envContent = readFileSync('/opt/docker/smallweb/data/kanban/.env', 'utf-8');
    const match = envContent.match(/API_TOKEN=(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

interface KanbanParams {
  action: string;
  title?: string;
  description?: string;
  lane?: string;
  priority?: number;
  cardId?: string | number;
  reason?: string;
  [key: string]: unknown;
}

interface KanbanCard {
  id: number;
  title: string;
  description?: string;
  lane: string;
  priority: number;
  agent?: string;
  blocked?: boolean;
  blocked_reason?: string;
  created_at: string;
}

async function kanbanFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = getToken();
  if (!token) {
    throw new Error('Kanban token not configured');
  }

  const response = await fetch(`${KANBAN_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Kanban API error: ${response.status}`);
  }

  return response.json();
}

async function handleKanban(
  params: KanbanParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;

  logger.info(`📋 Kanban handler - Action: ${action}`);

  try {
    switch (action) {
      case 'list': {
        const lane = params.lane;
        const cards: KanbanCard[] = await kanbanFetch('/cards');

        const filtered = lane
          ? cards.filter((c) => c.lane.toLowerCase() === lane.toLowerCase())
          : cards;

        if (filtered.length === 0) {
          return JSON.stringify({
            success: true,
            message: lane ? `No cards in ${lane} lane` : 'No cards on the board',
            cards: [],
          });
        }

        const summary = filtered.map((c) => ({
          id: c.id,
          title: c.title,
          lane: c.lane,
          priority: c.priority,
          blocked: c.blocked,
          agent: c.agent,
        }));

        return JSON.stringify({
          success: true,
          count: summary.length,
          cards: summary,
        });
      }

      case 'get': {
        const cardId = params.cardId;
        if (!cardId) {
          return JSON.stringify({ success: false, error: 'cardId required' });
        }

        const card: KanbanCard = await kanbanFetch(`/cards/${cardId}`);
        return JSON.stringify({ success: true, card });
      }

      case 'create': {
        const title = params.title || content;
        if (!title) {
          return JSON.stringify({ success: false, error: 'title required' });
        }

        const card = await kanbanFetch('/cards', {
          method: 'POST',
          body: JSON.stringify({
            title,
            description: params.description,
            lane: params.lane || 'Backlog',
            priority: params.priority || 2,
            agent: 'artie',
          }),
        });

        return JSON.stringify({
          success: true,
          message: `Created card #${card.id}: "${title}"`,
          card,
        });
      }

      case 'move': {
        const cardId = params.cardId;
        const lane = params.lane;
        if (!cardId || !lane) {
          return JSON.stringify({ success: false, error: 'cardId and lane required' });
        }

        const card = await kanbanFetch(`/cards/${cardId}`, {
          method: 'PATCH',
          body: JSON.stringify({ lane }),
        });

        return JSON.stringify({
          success: true,
          message: `Moved card #${cardId} to ${lane}`,
          card,
        });
      }

      case 'block': {
        const cardId = params.cardId;
        const reason = params.reason || content || 'Blocked by Artie';
        if (!cardId) {
          return JSON.stringify({ success: false, error: 'cardId required' });
        }

        const card = await kanbanFetch(`/cards/${cardId}/block`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });

        return JSON.stringify({
          success: true,
          message: `Blocked card #${cardId}: ${reason}`,
          card,
        });
      }

      case 'unblock': {
        const cardId = params.cardId;
        if (!cardId) {
          return JSON.stringify({ success: false, error: 'cardId required' });
        }

        const card = await kanbanFetch(`/cards/${cardId}/unblock`, {
          method: 'POST',
        });

        return JSON.stringify({
          success: true,
          message: `Unblocked card #${cardId}`,
          card,
        });
      }

      case 'active': {
        // Quick view of what's being worked on
        const cards: KanbanCard[] = await kanbanFetch('/cards');
        const active = cards.filter((c) => c.lane === 'Active');
        const blocked = cards.filter((c) => c.blocked);

        return JSON.stringify({
          success: true,
          active: active.map((c) => ({ id: c.id, title: c.title, agent: c.agent })),
          blocked: blocked.map((c) => ({ id: c.id, title: c.title, reason: c.blocked_reason })),
          summary: `${active.length} active, ${blocked.length} blocked`,
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Available: list, get, create, move, block, unblock, active`,
        });
    }
  } catch (error) {
    logger.error(`❌ Kanban error for action '${action}':`, error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const kanbanCapability: RegisteredCapability = {
  name: 'kanban',
  emoji: '📋',
  supportedActions: ['list', 'get', 'create', 'move', 'block', 'unblock', 'active'],
  description:
    'Access the shared kanban board for task coordination with VPS Claude. View active work, create tasks, update status.',
  handler: handleKanban,
  examples: [
    '<capability name="kanban" action="active" /> - See what\'s being worked on',
    '<capability name="kanban" action="list" lane="Blocked" /> - List blocked tasks',
    '<capability name="kanban" action="create" title="Research X" lane="Backlog" />',
    '<capability name="kanban" action="move" cardId="42" lane="Done" />',
  ],
};

export default kanbanCapability;

/**
 * System Memory Capability
 *
 * Shared memory space for cross-agent communication.
 * Both Artie and VPS Claude can read/write here.
 *
 * Use cases:
 * - Handoff notes between agents
 * - Observations that should persist across sessions
 * - Task context that both agents need
 * - Flags/signals between agents
 *
 * Note: VPS Claude also writes to Postgres mesh_memories directly
 * for durable cross-session persistence. This SQLite table is for
 * fast in-conversation handoffs.
 */

import { logger } from '../../../shared/logger.js';
import { getSyncDb } from '../../../shared/db/client.js';
import { getErrorMessage } from '../../../shared/errors.js';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../registry.js';

interface SystemMemoryParams {
  action: string;
  category?: string;
  content?: string;
  agent?: string;
  limit?: number;
  id?: number;
  [key: string]: unknown;
}

interface SystemMemoryEntry {
  id: number;
  agent: string;
  category: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  read_by: string[];
}

function ensureTable(): void {
  const db = getSyncDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      read_by TEXT DEFAULT '[]'
    )
  `);
}

async function handleSystemMemory(
  params: SystemMemoryParams,
  content?: string,
  _ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const callingAgent = params.agent || 'artie';

  logger.info(`🧠 System memory handler - Action: ${action}, Agent: ${callingAgent}`);
  ensureTable();
  const db = getSyncDb();

  try {
    switch (action) {
      case 'write': {
        const category = params.category || 'observation';
        const memContent = params.content || content;

        if (!memContent) {
          return JSON.stringify({ success: false, error: 'content required' });
        }

        const result = db.run(
          `INSERT INTO system_memory (agent, category, content, metadata) VALUES (?, ?, ?, ?)`,
          [callingAgent, category, memContent, JSON.stringify(params.metadata || {})]
        );

        return JSON.stringify({
          success: true,
          id: result.lastInsertRowid,
          message: `Stored ${category} note from ${callingAgent}`,
        });
      }

      case 'read': {
        const limit = params.limit || 10;
        const category = params.category;
        const fromAgent = params.agent;

        let sql = 'SELECT * FROM system_memory WHERE 1=1';
        const sqlParams: unknown[] = [];

        if (category) {
          sql += ' AND category = ?';
          sqlParams.push(category);
        }
        if (fromAgent) {
          sql += ' AND agent = ?';
          sqlParams.push(fromAgent);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        sqlParams.push(limit);

        const rows = db.all<Record<string, unknown>>(sql, sqlParams);

        const entries: SystemMemoryEntry[] = rows.map((row) => {
          let metadata: Record<string, unknown>;
          if (row.metadata) {
            metadata = JSON.parse(row.metadata as string);
          } else {
            metadata = {};
          }

          let readBy: string[];
          if (row.read_by) {
            readBy = JSON.parse(row.read_by as string);
          } else {
            readBy = [];
          }

          return {
            id: row.id as number,
            agent: row.agent as string,
            category: row.category as string,
            content: row.content as string,
            metadata: metadata,
            created_at: row.created_at as string,
            expires_at: row.expires_at as string | null,
            read_by: readBy,
          };
        });

        return JSON.stringify({
          success: true,
          count: entries.length,
          entries,
        });
      }

      case 'handoff': {
        // Convenience action: write a handoff note for the other agent
        const memContent = params.content || content;
        if (!memContent) {
          return JSON.stringify({ success: false, error: 'content required for handoff' });
        }

        let targetAgent: string;
        if (callingAgent === 'artie') {
          targetAgent = 'vps-claude';
        } else {
          targetAgent = 'artie';
        }

        const result = db.run(
          `INSERT INTO system_memory (agent, category, content, metadata) VALUES (?, ?, ?, ?)`,
          [
            callingAgent,
            'handoff',
            memContent,
            JSON.stringify({ for: targetAgent }),
          ]
        );

        return JSON.stringify({
          success: true,
          id: result.lastInsertRowid,
          message: `Handoff note left by ${callingAgent}`,
        });
      }

      case 'check_handoffs': {
        // Check for handoff notes addressed to this agent
        const rows = db.all<Record<string, unknown>>(
          `SELECT * FROM system_memory
           WHERE category = 'handoff'
           AND json_extract(metadata, '$.for') = ?
           ORDER BY created_at DESC LIMIT 5`,
          [callingAgent]
        );

        const handoffs = rows.map((row) => ({
          id: row.id as number,
          from: row.agent as string,
          content: row.content as string,
          created_at: row.created_at as string,
        }));

        let message: string;
        if (handoffs.length > 0) {
          message = `${handoffs.length} handoff notes waiting`;
        } else {
          message = 'No pending handoffs';
        }

        return JSON.stringify({
          success: true,
          count: handoffs.length,
          handoffs,
          message: message,
        });
      }

      case 'recent': {
        // Quick view of recent cross-agent activity
        const rows = db.all<Record<string, unknown>>(
          `SELECT * FROM system_memory ORDER BY created_at DESC LIMIT 10`
        );

        const summary = rows.map((row) => {
          const content = row.content as string;
          const contentPreview = content.slice(0, 100);
          let ellipsis: string;
          if (content.length > 100) {
            ellipsis = '...';
          } else {
            ellipsis = '';
          }
          const preview = contentPreview + ellipsis;
          return {
            id: row.id,
            agent: row.agent,
            category: row.category,
            preview: preview,
            created_at: row.created_at,
          };
        });

        return JSON.stringify({
          success: true,
          entries: summary,
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Available: write, read, handoff, check_handoffs, recent`,
        });
    }
  } catch (error) {
    logger.error(`❌ System memory error for action '${action}':`, error);
    return JSON.stringify({
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export const systemMemoryCapability: RegisteredCapability = {
  name: 'system_memory',
  emoji: '🧠',
  // Rows in one shared SQLite table (system_memory) that Artie and VPS Claude both read; nothing
  // here is per user or per server, and nothing is recalled into conversations automatically.
  actions: {
    read: {
      effect: 'read',
      who: 'owner',
      params: {
        category: { type: 'string', description: 'Only this category (observation, handoff, ...)' },
        agent: { type: 'string', description: 'Only notes written by this agent' },
        limit: { type: 'integer', description: 'Max rows (default 10)' },
      },
    },
    recent: { effect: 'read', who: 'owner' },
    check_handoffs: {
      effect: 'read',
      who: 'owner',
      params: { agent: { type: 'string', description: 'Whose inbox to check (default artie)' } },
    },
    write: {
      effect: 'own',
      who: 'owner',
      content: 'The note text',
      params: {
        category: { type: 'string', description: 'Note category (default observation)' },
        agent: { type: 'string', description: 'Who is writing (default artie)' },
      },
    },
    handoff: {
      effect: 'own',
      who: 'owner',
      content: 'What the other agent should pick up',
      params: { agent: { type: 'string', description: 'Who is writing (default artie)' } },
    },
  },
  supportedActions: ['write', 'read', 'handoff', 'check_handoffs', 'recent'],
  description:
    'EJ-only shared notebook between Artie and VPS Claude (the other agent): handoffs and agent-to-agent notes. NOT for facts about users or servers (use memory).\n' +
    'Rows are not per user or per server and are never recalled into chats automatically; read or check_handoffs to see them.',
  handler: handleSystemMemory,
  examples: [
    '<capability name="system_memory" action="handoff" content="User asked about X, needs follow-up research" />',
    '<capability name="system_memory" action="check_handoffs" agent="artie" />',
    '<capability name="system_memory" action="recent" /> - See recent cross-agent activity',
    '<capability name="system_memory" action="write" category="observation" content="User prefers..." />',
  ],
};

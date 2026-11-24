/**
 * P16 (state-machine audit 2026-10-31): storeMemory handed back a temp negative id and swapped
 * in the real one a moment later, so the semantic tagger's getMemory(tempId) found nothing
 * (0 of 65 tags landed Oct 29-31) and the model was shown a negative id.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'memory-real-id-')), 'test.db');

vi.mock('../../../src/engine/4-generate/openrouter.js', () => ({
  openRouterService: {
    generateFromMessageChain: vi.fn(async () => '{"tags": ["semantic-tag-from-llm"]}'),
  },
}));

let store: typeof import('../../../src/engine/memory/store.js');
let memoryModule: typeof import('../../../src/engine/capabilities/core/memory.js');

beforeAll(async () => {
  const { getSyncDb } = await import('../../../src/shared/db/client.js');
  const db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
    importance INTEGER DEFAULT 5, metadata TEXT DEFAULT '{}')`);
  for (const col of [
    'guild_id TEXT', 'channel_id TEXT', 'related_message_id TEXT',
    'created_at TEXT', 'updated_at TEXT', 'embedding TEXT',
  ]) {
    try {
      db.run(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {
      // bootstrap already has it
    }
  }
  store = await import('../../../src/engine/memory/store.js');
  memoryModule = await import('../../../src/engine/capabilities/core/memory.js');
});

describe('storeMemory id', () => {
  it('returns the real, persisted id', async () => {
    const id = await store.memoryStore.storeMemory({
      user_id: 'real-id-user',
      content: 'likes trains',
      tags: '[]',
      context: '',
      timestamp: new Date().toISOString(),
      importance: 5,
      metadata: '{}',
    });
    expect(id).toBeGreaterThan(0);
    expect(await store.memoryStore.getMemory(id)).not.toBeNull();
  });

  it('remember() shows a positive id and the semantic tags land on that memory', async () => {
    const service = memoryModule.MemoryService.getInstance();
    const result = await service.remember('real-id-user-2', 'prefers night trains', '', 5);
    const match = result.match(/ID: (-?\d+)/);
    expect(match, result).toBeTruthy();
    const id = Number(match![1]);
    expect(id).toBeGreaterThan(0);

    await vi.waitFor(async () => {
      const memory = await store.memoryStore.getMemory(id);
      expect(memory?.tags).toContain('semantic-tag-from-llm');
    });
  });
});

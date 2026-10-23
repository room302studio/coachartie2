import { describe, it, expect, beforeAll } from 'vitest';
import { getSyncDb } from '../../src/shared/db/client.js';
import { likeSearchOwnMemories } from '../../src/gateway/commands/user-memories.js';
import { escapeLike, escapeFts5 } from '../../src/shared/sql-escape.js';

// Wave 7 / ledger #12: the LIKE fallback escapes % and _ instead of deleting them.
describe('LIKE fallback for /memory search', () => {
  beforeAll(() => {
    const db = getSyncDb();
    db.run(`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', context TEXT DEFAULT '', timestamp TEXT NOT NULL,
      importance INTEGER DEFAULT 5)`);
    const add = (content: string) =>
      db.run(`INSERT INTO memories (user_id, content, tags, timestamp, importance) VALUES (?, ?, '[]', ?, 5)`, [
        'like-user',
        content,
        new Date().toISOString(),
      ]);
    add('rename it to snake_case please');
    add('snakeXcase is a typo');
    add('battery at 50% today');
    add('plain memory');
  });

  const find = (q: string) => likeSearchOwnMemories('like-user', q, 20).map((r) => r.content);

  it("'snake_case' finds the memory containing snake_case, and only that one", () => {
    expect(find('snake_case')).toEqual(['rename it to snake_case please']);
  });

  it("'%' matches a literal percent sign, not everything", () => {
    expect(find('%')).toEqual(['battery at 50% today']);
  });

  it('a backslash in the query is literal too', () => {
    expect(find('\\')).toEqual([]);
  });
});

describe('sql-escape helpers', () => {
  it('escapeLike escapes %, _ and the escape char', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
  it('escapeFts5 quotes a phrase and doubles inner quotes', () => {
    expect(escapeFts5('say "hi" OR x')).toBe('"say ""hi"" OR x"');
  });
});

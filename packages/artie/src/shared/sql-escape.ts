/**
 * Escaping for user text inside SQLite search syntax. Values still go in as bound
 * parameters; these only neutralize the operators of the mini-language inside them.
 */

/**
 * One FTS5 phrase: wrapped in double quotes with inner quotes doubled, so AND/OR/NEAR,
 * column filters and '*' in user text are matched as plain words.
 */
export function escapeFts5(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * A LIKE pattern body that matches `term` literally. Use with `LIKE ? ESCAPE '\'`:
 * '%' and '_' are escaped instead of deleted (ledger #12), so 'snake_case' finds
 * 'snake_case' and '%' finds a literal percent sign.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The `artie-enemy` Discord role: Artie gives it out (discord-moderation add_enemy_role) and
 * ignores whoever has it: their messages stop at intake, before any LLM call, so no reply, no
 * reaction, no tokens. Softer than the blocklist (shared/blocklist.ts): they stay visible in
 * channel history and memory, and remove_enemy_role undoes it. Until 2026-11-24 nothing read
 * the role back, so it was only a label.
 */
export const ARTIE_ENEMY_ROLE_NAME = 'artie-enemy';

export function isArtieEnemyRole(roleName: string | null | undefined): boolean {
  return !!roleName && roleName.trim().toLowerCase() === ARTIE_ENEMY_ROLE_NAME;
}

export function hasArtieEnemyRole(roleNames: Iterable<string | null | undefined>): boolean {
  for (const name of roleNames) {
    if (isArtieEnemyRole(name)) {
      return true;
    }
  }
  return false;
}

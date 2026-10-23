/** Escape a string for literal use inside `new RegExp(...)`. The one shared copy. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

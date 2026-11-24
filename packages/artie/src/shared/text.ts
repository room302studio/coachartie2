/**
 * Small text helpers that used to be copy-pasted one-liners (ledger Top-5 #5, wave 10).
 * Dependency-free on purpose: logger.ts imports this file.
 *
 * Related single homes elsewhere: escapeRegex (shared/regex.ts), escapeFts5/escapeLike
 * (shared/sql-escape.ts), isStaffRole (shared/staff-role.ts), isEmail (shared/email.ts),
 * replaceMention (shared/mentions.ts).
 */

/** Every run of whitespace (newlines included) becomes one space. Does not trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** Remove leading and trailing occurrences of the given separator. */
function trimSeparator(slug: string, sep: '-' | '_'): string {
  if (sep === '-') {
    return slug.replace(/^-|-$/g, '');
  }
  return slug.replace(/^_|_$/g, '');
}

/** Lowercase, every run of non-[a-z0-9] becomes `sep`, no leading/trailing `sep`. */
export function slugify(s: string, sep: '-' | '_' = '-'): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, sep);
  return trimSeparator(slug, sep);
}

/** A base URL without its trailing slash(es), so `${base}/path` has exactly one. */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Safe for a filename or key: every char outside [a-zA-Z0-9_-] becomes '_'. Case kept. */
export function sanitizeIdentifier(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** '...' when the text is longer than maxLength (to append after a cut), else ''. */
export function truncationSuffix(text: string, maxLength: number): string {
  if (text.length > maxLength) {
    return '...';
  }
  return '';
}

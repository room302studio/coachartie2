/**
 * Reading the params a model passes to a capability. Models send every value as a string, or
 * as a loose JSON type, so these turn them into what a handler wants. One copy of each, so two
 * capabilities never disagree on what "missing" or "yes" means.
 */

/** undefined, null and '' are missing; anything else becomes a string (0 and false included). */
export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

/** Any falsy value is missing (0 and false too); anything else becomes a string. */
export function truthyString(value: unknown): string | undefined {
  if (value) {
    return String(value);
  }
  return undefined;
}

/** The value only if it already is a string. */
export function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** A whole number within [min, max]; the fallback when it isn't a number at all. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/** True for a yes in any spelling a model sends: true, "true", "yes", "1". */
export function isYes(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  return ['true', 'yes', '1'].includes(String(value ?? '').trim().toLowerCase());
}

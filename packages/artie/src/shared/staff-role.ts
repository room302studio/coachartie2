/**
 * The ONE staff-role test. Discord role names like "Dev", "Staff", "ADMIN" or "SBAT Crew"
 * are staff; "devops" is not (whole words only). Case-insensitive.
 *
 * Used by the moderation route (who can't be timed out), the outbound gate (protected
 * timeout targets), channel history (the [staff] tag) and the Subway Builder clap-back
 * guard. There were four copies, two without /i (they lowercased first, so they agreed,
 * but only by accident).
 */
const STAFF_ROLE_RE = /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/i;

export function isStaffRole(roleName: string | null | undefined): boolean {
  return !!roleName && STAFF_ROLE_RE.test(roleName);
}

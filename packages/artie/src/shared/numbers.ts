/** Small number helpers that used to be copy-pasted. */

/** part / whole as a whole-number percent; 0 when whole is 0 or less. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 100);
}

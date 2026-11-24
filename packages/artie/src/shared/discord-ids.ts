/** Discord ids (snowflakes): one pattern for every place that checks one. */

/** A bare snowflake: 15 to 22 digits. */
export const SNOWFLAKE = /^\d{15,22}$/;

/** True when the value is a string holding exactly one snowflake. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

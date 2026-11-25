import { describe, it, expect } from 'vitest';
import { mentionsUser } from '../../src/shared/mentions.js';

// 2026-11-24: any role mention vetoed a real @Artie in the same message, so he ignored it.
describe('mentionsUser', () => {
  const artie = '123456789';

  it('a direct mention, either form, counts', () => {
    expect(mentionsUser(`<@${artie}> hi`, artie)).toBe(true);
    expect(mentionsUser(`hey <@!${artie}>`, artie)).toBe(true);
  });

  it('a role mention or @everyone beside it does not cancel it', () => {
    expect(mentionsUser(`<@&555> <@${artie}> help`, artie)).toBe(true);
    expect(mentionsUser(`@everyone <@${artie}> look`, artie)).toBe(true);
  });

  it('role mentions, @everyone and other users alone do not count', () => {
    expect(mentionsUser(`<@&${artie}> hi`, artie)).toBe(false);
    expect(mentionsUser('@everyone hi', artie)).toBe(false);
    expect(mentionsUser(`<@${artie}0> hi`, artie)).toBe(false);
    expect(mentionsUser('<@987> hi', artie)).toBe(false);
  });
});

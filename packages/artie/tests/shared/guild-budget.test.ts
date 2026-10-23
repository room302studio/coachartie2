import { describe, it, expect, afterEach } from 'vitest';
import {
  parseGuildBudgetShares,
  guildBudgetShare,
  checkGuildBudget,
  GuildBudgetExceededError,
  SUBWAY_BUILDER_GUILD_ID,
} from '../src/utils/guild-budget.js';
import { GenerationMutedError } from '../src/utils/kill-switch.js';

afterEach(() => {
  delete process.env.GUILD_BUDGET_SHARES;
  delete process.env.DAILY_BUDGET_USD;
});

describe('guild budget shares', () => {
  it('defaults to Subway Builder at a hard 50%', () => {
    expect(guildBudgetShare(SUBWAY_BUILDER_GUILD_ID)).toBe(0.5);
    expect(guildBudgetShare('932719842522443928')).toBeNull(); // Room 302 uncapped
    expect(guildBudgetShare(null)).toBeNull(); // DMs
  });

  it('parses overrides, ignores junk, and can be turned off', () => {
    const m = parseGuildBudgetShares('111:0.25, 222:1, 333:2, bad, 444:x');
    expect([...m.entries()]).toEqual([['111', 0.25], ['222', 1]]);
    expect(parseGuildBudgetShares('off').size).toBe(0);
  });

  it('scales the cap with whatever the daily budget is', () => {
    const at = new Date('2026-09-29T15:00:00Z');
    expect(checkGuildBudget(SUBWAY_BUILDER_GUILD_ID, at, () => 1.49)).toMatchObject({ capUsd: 1.5, over: false });
    expect(checkGuildBudget(SUBWAY_BUILDER_GUILD_ID, at, () => 1.5)?.over).toBe(true);
    process.env.DAILY_BUDGET_USD = '10';
    expect(checkGuildBudget(SUBWAY_BUILDER_GUILD_ID, at, () => 4)).toMatchObject({ capUsd: 5, over: false });
  });

  it('is off when the guild is uncapped, the budget is off, or the lookup fails (fail open)', () => {
    expect(checkGuildBudget('932719842522443928', new Date(), () => 99)).toBeNull();
    process.env.DAILY_BUDGET_USD = 'off';
    expect(checkGuildBudget(SUBWAY_BUILDER_GUILD_ID, new Date(), () => 99)).toBeNull();
    delete process.env.DAILY_BUDGET_USD;
    expect(checkGuildBudget(SUBWAY_BUILDER_GUILD_ID, new Date(), () => { throw new Error('db'); })).toBeNull();
  });

  it('is a GenerationMutedError, so existing callers treat it as silent', () => {
    const err = new GuildBudgetExceededError('test', { guildId: 'g', capUsd: 1.5, spentUsd: 1.6, over: true });
    expect(err).toBeInstanceOf(GenerationMutedError);
  });
});

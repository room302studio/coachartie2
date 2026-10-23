import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  REPO_ROOT,
  getKillSwitch,
  getStrikeMode,
  getSteamReviewNotes,
  getCasinoLedger,
  LAUNCH_STATE,
  getDatabasePath,
  CAPABILITIES_GUILD_NOTES,
  MENTION_PROXY_DATA,
  PROMPTS_DIR,
  REFERENCE_DOCS,
  ENGINE_LOGS,
  GATEWAY_LOGS,
  PM2_LOGS,
  getLogsDir,
  SKILLS_DIRS,
  getGuildKnowledgeDirs,
  getEnvFiles,
} from '../src/paths.js';

describe('REPO_ROOT', () => {
  it('contains pnpm-workspace.yaml', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('single files', () => {
  // Each of these env vars is snapshotted and restored so this test doesn't leak into others
  // (vitest's sequence.concurrent: false means these run serially, but state would otherwise
  // survive into later test FILES in the same worker).
  const snapshot: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'KILL_SWITCH_PATH',
    'STRIKE_PATH',
    'STEAM_REVIEW_NOTES_PATH',
    'CASINO_LEDGER_PATH',
    'DATABASE_PATH',
  ];
  beforeEach(() => {
    for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('getKillSwitch() resolves to <repo>/KILL_SWITCH', () => {
    delete process.env.KILL_SWITCH_PATH;
    expect(getKillSwitch()).toBe(join(REPO_ROOT, 'KILL_SWITCH'));
  });

  it('getKillSwitch() still lets KILL_SWITCH_PATH win', () => {
    process.env.KILL_SWITCH_PATH = '/tmp/some-other-kill-switch';
    expect(getKillSwitch()).toBe('/tmp/some-other-kill-switch');
  });

  it('getStrikeMode() resolves to <repo>/STRIKE_MODE', () => {
    delete process.env.STRIKE_PATH;
    expect(getStrikeMode()).toBe(join(REPO_ROOT, 'STRIKE_MODE'));
  });

  it('getSteamReviewNotes() resolves to <repo>/reference-docs/subwaybuilder/steam-review-notes.md', () => {
    delete process.env.STEAM_REVIEW_NOTES_PATH;
    expect(getSteamReviewNotes()).toBe(
      join(REPO_ROOT, 'reference-docs/subwaybuilder/steam-review-notes.md')
    );
  });

  it('getCasinoLedger() resolves to <repo>/packages/discord/data/casino-ledger.json', () => {
    delete process.env.CASINO_LEDGER_PATH;
    expect(getCasinoLedger()).toBe(join(REPO_ROOT, 'packages/discord/data/casino-ledger.json'));
  });

  it('LAUNCH_STATE resolves to <repo>/packages/discord/data/launch-countdown-state.json', () => {
    expect(LAUNCH_STATE).toBe(
      join(REPO_ROOT, 'packages/discord/data/launch-countdown-state.json')
    );
  });

  it('getDatabasePath() resolves to <repo>/data/coachartie.db when DATABASE_PATH is unset', () => {
    delete process.env.DATABASE_PATH;
    expect(getDatabasePath()).toBe(join(REPO_ROOT, 'data/coachartie.db'));
  });

  it('getDatabasePath() still lets DATABASE_PATH win (this is how every test run sets it)', () => {
    process.env.DATABASE_PATH = ':memory:';
    expect(getDatabasePath()).toBe(':memory:');
  });
});

describe('directories', () => {
  it('CAPABILITIES_GUILD_NOTES resolves to <repo>/packages/capabilities/reference-docs/guild-notes', () => {
    expect(CAPABILITIES_GUILD_NOTES).toBe(
      join(REPO_ROOT, 'packages/capabilities/reference-docs/guild-notes')
    );
  });

  it('MENTION_PROXY_DATA resolves to <repo>/capabilities/data (not packages/capabilities/data)', () => {
    expect(MENTION_PROXY_DATA).toBe(join(REPO_ROOT, 'capabilities/data'));
  });

  it('PROMPTS_DIR resolves to <repo>/prompts', () => {
    expect(PROMPTS_DIR).toBe(join(REPO_ROOT, 'prompts'));
  });

  it('REFERENCE_DOCS has both the root and capabilities trees', () => {
    expect(REFERENCE_DOCS.root).toBe(join(REPO_ROOT, 'reference-docs'));
    expect(REFERENCE_DOCS.capabilities).toBe(join(REPO_ROOT, 'packages/capabilities/reference-docs'));
  });

  it('ENGINE_LOGS resolves to <repo>/packages/capabilities/logs', () => {
    expect(ENGINE_LOGS).toBe(join(REPO_ROOT, 'packages/capabilities/logs'));
  });

  it('GATEWAY_LOGS resolves to <repo>/packages/discord/logs', () => {
    expect(GATEWAY_LOGS).toBe(join(REPO_ROOT, 'packages/discord/logs'));
  });

  it('PM2_LOGS resolves to <repo>/logs (PM2 out/error dir, not a winston dir)', () => {
    expect(PM2_LOGS).toBe(join(REPO_ROOT, 'logs'));
  });
});

describe('getLogsDir', () => {
  const originalLogsDir = process.env.LOGS_DIR;
  afterEach(() => {
    if (originalLogsDir === undefined) delete process.env.LOGS_DIR;
    else process.env.LOGS_DIR = originalLogsDir;
  });

  it('LOGS_DIR env always wins', () => {
    process.env.LOGS_DIR = '/tmp/some-other-logs';
    expect(getLogsDir()).toBe('/tmp/some-other-logs');
  });

  it('falls back to <cwd>/logs for an unrecognized package (e.g. shared itself)', () => {
    delete process.env.LOGS_DIR;
    // vitest runs shared's own tests with cwd = packages/shared (turbo sets this per package).
    expect(getLogsDir()).toBe(join(process.cwd(), 'logs'));
  });
});

describe('SKILLS_DIRS', () => {
  it('is the three real candidates, highest priority first', () => {
    expect(SKILLS_DIRS).toEqual([
      join(REPO_ROOT, 'packages/capabilities/skills'),
      join(process.env.HOME || '', '.coachartie/skills'),
      join(REPO_ROOT, 'packages/capabilities/src/skills'),
    ]);
  });
});

describe('getGuildKnowledgeDirs', () => {
  afterEach(() => {
    delete process.env.APP_ROOT;
  });

  it('matches the historical search order when APP_ROOT is unset', () => {
    delete process.env.APP_ROOT;
    expect(getGuildKnowledgeDirs()).toEqual([
      join(REPO_ROOT, 'packages/capabilities'),
      REPO_ROOT,
      '/data2/apps/coachartie2',
      '/data2/coachartie2',
      '/app',
    ]);
  });

  it('puts APP_ROOT first when it is set', () => {
    process.env.APP_ROOT = '/custom/app/root';
    expect(getGuildKnowledgeDirs()[0]).toBe('/custom/app/root');
  });
});

describe('getEnvFiles', () => {
  it('returns the repo-root .env then the package .env, for capabilities', () => {
    expect(getEnvFiles('capabilities')).toEqual([
      join(REPO_ROOT, '.env'),
      join(REPO_ROOT, 'packages/capabilities/.env'),
    ]);
  });

  it('returns the repo-root .env then the package .env, for discord', () => {
    expect(getEnvFiles('discord')).toEqual([
      join(REPO_ROOT, '.env'),
      join(REPO_ROOT, 'packages/discord/.env'),
    ]);
  });
});

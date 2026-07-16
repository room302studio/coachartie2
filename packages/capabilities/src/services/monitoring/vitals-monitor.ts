import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createQueue, logger } from '@coachartie/shared';
import { CreditMonitor } from './credit-monitor.js';

/**
 * VitalsMonitor — Artie's self-audit loop (Beer's System 4 + algedonic channel).
 *
 * Why: 500 reply jobs died on the 180s deadline over 24h and nobody noticed;
 * credits hit $0 silently; the warden-timeout feature never fired once and
 * nothing flagged it. The operator was learning about fevers from Discord
 * vibes. Every tick this greps the same log tails a human would have tailed,
 * logger.warn's a one-line summary (the vitals feed), and DMs the operator
 * when a threshold is breached. Deliberately dumb: no DB, no metrics pipeline.
 */

const SIGNALS = [
  { key: 'deadlineKills', re: /TIMEOUT: Global job timeout/ },
  { key: 'emptyGen', re: /Empty\/failed generation/ },
  { key: 'outOfCredits', re: /OUT OF CREDITS/ },
  { key: 'routeSimple', re: /Model route: SIMPLE/ },
  { key: 'routeSmart', re: /Model route: (MODERATE|COMPLEX)/ },
  { key: 'warden', re: /Timed out .+ for \d+s/ },
  { key: 'proxy', re: /Proxying for @/ },
  // \b keeps snowflake IDs and this file's own "rl429=" summary token from matching.
  { key: 'rl429', re: /\b429\b/ },
] as const;
type SignalKey = (typeof SIGNALS)[number]['key'];
type Counts = Record<SignalKey, number>;

// PM2 out logs prefix each entry with 'YYYY-MM-DD HH:mm:ss:' (server-local time).
const LINE_TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}):/;

// Newest file per prefix wins (PM2 suffixes rotations); no trailing dash so both
// 'discord-out.log' and 'discord-out-1.log' naming schemes match.
const LOG_PREFIXES = ['capabilities-out', 'discord-out'];

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// One queue for all operator DMs — createQueue opens a fresh redis connection
// per call and nothing closes it, so hoist instead of leaking one per DM.
let dmQueue: ReturnType<typeof createQueue> | null = null;

async function sendOperatorDM(content: string, source: string): Promise<void> {
  try {
    const adminDiscordId = process.env.ADMIN_DISCORD_ID;
    if (!adminDiscordId) {
      logger.warn(`🩺 Vitals: no ADMIN_DISCORD_ID configured — dropping DM (${source})`);
      return;
    }
    dmQueue ??= createQueue('coachartie-discord-outgoing');
    await dmQueue.add('send-message', { userId: adminDiscordId, content, source });
    logger.warn(`🩺 Vitals: sent operator DM (${source})`);
  } catch (error) {
    logger.error(`❌ Vitals: failed to send operator DM (${source}):`, error);
  }
}

export class VitalsMonitor {
  private static instance: VitalsMonitor;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 60 * 60 * 1000;
  private lastAlarmAt = 0;

  private constructor() {}

  static getInstance(): VitalsMonitor {
    if (!VitalsMonitor.instance) {
      VitalsMonitor.instance = new VitalsMonitor();
    }
    return VitalsMonitor.instance;
  }

  start(): void {
    if (this.tickTimer) return;
    this.intervalMs = envNum('VITALS_INTERVAL_MS', 60 * 60 * 1000);
    this.tickTimer = setInterval(() => void this.tick(), this.intervalMs);
    this.tickTimer.unref?.();
    logger.warn(`🩺 Vitals monitor started (every ${Math.round(this.intervalMs / 60000)}min)`);
  }

  /** One audit pass. Fails soft — a broken tick must never stop future ticks. */
  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      const counts = await this.collectCounts(now - this.intervalMs, now);
      const runwayHours = await this.getRunwayHours();

      // Always visible in prod (CONSOLE_LOG_LEVEL=warn) — this line IS the vitals feed.
      logger.warn(
        `🩺 Vitals [${Math.round(this.intervalMs / 60000)}min]: ` +
          `deadlineKills=${counts.deadlineKills} emptyGen=${counts.emptyGen} ` +
          `outOfCredits=${counts.outOfCredits} route S/M=${counts.routeSimple}/${counts.routeSmart} ` +
          `warden=${counts.warden} proxy=${counts.proxy} rl429=${counts.rl429} ` +
          `runway=${runwayHours === null ? '?' : `${runwayHours.toFixed(1)}h`}`
      );

      await this.maybeAlarm(counts, runwayHours, now);
    } catch (error) {
      logger.warn(`🩺 Vitals tick failed (skipping this interval): ${error}`);
    }
  }

  private async collectCounts(sinceMs: number, untilMs: number): Promise<Counts> {
    const counts = Object.fromEntries(SIGNALS.map((s) => [s.key, 0])) as Counts;
    const logDir = process.env.VITALS_LOG_DIR || '/data2/apps/coachartie2/logs';

    let entries: string[];
    try {
      entries = await fs.readdir(logDir);
    } catch (error) {
      logger.warn(`🩺 Vitals: cannot read log dir ${logDir}: ${error}`);
      return counts;
    }

    for (const prefix of LOG_PREFIXES) {
      const file = await this.newestByMtime(logDir, entries, prefix);
      if (!file) {
        logger.warn(`🩺 Vitals: no '${prefix}*.log' file found in ${logDir}`);
        continue;
      }
      const text = await this.readTail(file);
      if (text !== null) {
        this.countWindow(text, sinceMs, untilMs, counts);
      }
    }
    return counts;
  }

  private async newestByMtime(dir: string, entries: string[], prefix: string): Promise<string | null> {
    let newest: string | null = null;
    let newestMtime = -1;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.log')) continue;
      try {
        const stat = await fs.stat(join(dir, name));
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newest = join(dir, name);
        }
      } catch {
        // rotated away between readdir and stat — skip
      }
    }
    return newest;
  }

  private async readTail(filePath: string): Promise<string | null> {
    const maxBytes = envNum('VITALS_TAIL_BYTES', 5 * 1024 * 1024);
    try {
      const stat = await fs.stat(filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      if (length <= 0) return '';
      const handle = await fs.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(length);
        // read() may return short — loop until the requested range is filled
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        return buf.toString('utf8', 0, offset);
      } finally {
        await handle.close();
      }
    } catch (error) {
      logger.warn(`🩺 Vitals: cannot read ${filePath}: ${error}`);
      return null;
    }
  }

  /**
   * Walk lines tracking the last-seen timestamp so multi-line entries (stack
   * traces) inherit the timestamp of the entry they belong to.
   */
  private countWindow(text: string, sinceMs: number, untilMs: number, counts: Counts): void {
    let lastTs: number | null = null;
    for (const line of text.split('\n')) {
      const m = LINE_TS_RE.exec(line);
      if (m) {
        // no zone suffix → parses as LOCAL time, matching what PM2 writes
        const parsed = new Date(`${m[1]}T${m[2]}`).getTime();
        if (!Number.isNaN(parsed)) lastTs = parsed;
      }
      if (lastTs === null || lastTs < sinceMs || lastTs >= untilMs) continue;
      for (const signal of SIGNALS) {
        if (signal.re.test(line)) counts[signal.key]++;
      }
    }
  }

  private async getRunwayHours(): Promise<number | null> {
    try {
      const info = await CreditMonitor.getInstance().getCurrentBalance();
      const balance = info?.credits_remaining;
      if (typeof balance !== 'number') return null;
      return balance / envNum('VITALS_ASSUMED_BURN_PER_HOUR', 1.5);
    } catch (error) {
      logger.warn(`🩺 Vitals: runway check failed: ${error}`);
      return null;
    }
  }

  /** The algedonic channel: one DM listing every breached vital, throttled. */
  private async maybeAlarm(counts: Counts, runwayHours: number | null, now: number): Promise<void> {
    const intervalHours = this.intervalMs / (60 * 60 * 1000);
    const breaches: string[] = [];
    const over = (count: number, perHourEnv: string, perHourDefault: number, label: string) => {
      const limit = envNum(perHourEnv, perHourDefault) * intervalHours;
      if (count > limit) breaches.push(`**${count} ${label}** in the last interval (threshold ${limit})`);
    };
    over(counts.deadlineKills, 'VITALS_MAX_JOB_DEADLINE_KILLS_PER_HOUR', 15, 'job deadline kills — replies dying on the 180s wall');
    over(counts.emptyGen, 'VITALS_MAX_EMPTY_GENERATIONS_PER_HOUR', 15, 'empty/failed generations');
    over(counts.rl429, 'VITALS_MAX_429S_PER_HOUR', 10, 'rate-limit 429s');
    const minRunway = envNum('VITALS_MIN_RUNWAY_HOURS', 12);
    if (runwayHours !== null && runwayHours < minRunway) {
      breaches.push(
        `**Credit runway ~${runwayHours.toFixed(1)}h** (floor ${minRunway}h) — top up: https://openrouter.ai/settings/credits`
      );
    }
    if (breaches.length === 0) return;

    const throttleMs = envNum('VITALS_ALARM_THROTTLE_MS', 4 * 60 * 60 * 1000);
    if (now - this.lastAlarmAt < throttleMs) {
      logger.warn(`🩺 Vitals: ${breaches.length} breach(es) but alarm DM throttled`);
      return;
    }
    this.lastAlarmAt = now;
    await sendOperatorDM(
      `🚨 **Vitals alarm — I'm running a fever.**\n\n` +
        breaches.map((b) => `• ${b}`).join('\n') +
        `\n\nCheck \`pm2 logs coach-artie-capabilities coach-artie-discord\` on the VPS.`,
      'vitals-monitor-alarm'
    );
  }
}

export const vitalsMonitor = VitalsMonitor.getInstance();

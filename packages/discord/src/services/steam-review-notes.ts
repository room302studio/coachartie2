import { logger, isBlockedUser } from '@coachartie/shared';
import { Client, TextChannel, Message } from 'discord.js';
import fetch from 'node-fetch';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Steam Review Notes Service
 *
 * Watches #steam-reviews in the Subway Builder guild, where the Steamy bot posts
 * each new Steam review as an embed and humans discuss them. Maintains an ongoing
 * intelligence document (reference-docs/subwaybuilder/steam-review-notes.md):
 *
 * - Review Log: every review appended verbatim by code — lossless, deterministic.
 * - Tally: 👍/👎 counts, recounted from the log each cycle.
 * - Situation Analysis: LLM-maintained (via capabilities /api/observe) — recurring
 *   themes with counts, sentiment trajectory, quotes, community reaction.
 *
 * The doc is readable by Artie via <readfile> (pointed to from the guild prompt),
 * so "how are the reviews going?" gets answered from real accumulated notes instead
 * of whatever happens to be in channel history. The service never posts to Discord —
 * it only reads and takes notes (Artie is mention-only as of 2026-07-19).
 *
 * State: the pagination cursor lives in the notes file header (<!-- cursor:ID -->),
 * so there's no extra table and the file is the single source of truth.
 */

const STEAM_REVIEWS_CHANNEL_ID =
  process.env.STEAM_REVIEWS_CHANNEL_ID || '1527715803884027984'; // #steam-reviews in Subway Builder
const NOTES_PATH =
  process.env.STEAM_REVIEW_NOTES_PATH || 'reference-docs/subwaybuilder/steam-review-notes.md';
const POLL_INTERVAL_MS = parseInt(process.env.STEAM_REVIEW_POLL_MS || '600000'); // 10 min
const ANALYSIS_MIN_INTERVAL_MS = parseInt(process.env.STEAM_REVIEW_ANALYSIS_MIN_MS || '1800000'); // 30 min
const MAX_MESSAGES_PER_CYCLE = 1000;
const CHATTER_BUFFER_MAX = 80; // recent human lines carried into the next analysis

const CURSOR_RE = /<!-- cursor:(\d+) -->/;
const ANALYSIS_START = '<!-- analysis:start -->';
const ANALYSIS_END = '<!-- analysis:end -->';
const LOG_START = '<!-- log:start -->';
const LOG_END = '<!-- log:end -->';

const SKELETON = `<!-- Maintained by the steam-review-notes service (packages/discord/src/services/steam-review-notes.ts).
     The cursor comment and the sections between the analysis/log markers are machine-written — hand edits
     to the analysis section will be overwritten on the next refresh; the review log is append-only. -->
<!-- cursor:0 -->

# Steam Reviews — The Situation

**Tally:** (no reviews logged yet)

## Situation Analysis

${ANALYSIS_START}
_No analysis yet — waiting for the first batch of reviews._
${ANALYSIS_END}

## Review Log

${LOG_START}
${LOG_END}
`;

interface ReviewEntry {
  date: string; // YYYY-MM-DD HH:MM UTC
  verdict: '👍' | '👎' | '❓';
  hours: string;
  language: string;
  text: string;
}

export class SteamReviewNotes {
  private static instance: SteamReviewNotes;
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAnalysisAt = 0;
  // True when the log has entries the analysis hasn't seen. Starts true so the first
  // cycle after a restart reconciles any refresh that failed before the restart.
  private analysisPending = true;
  private chatterBuffer: string[] = [];
  private readonly CAPABILITIES_URL = process.env.CAPABILITIES_URL || 'http://localhost:47324';

  private constructor() {}

  static getInstance(): SteamReviewNotes {
    if (!SteamReviewNotes.instance) {
      SteamReviewNotes.instance = new SteamReviewNotes();
    }
    return SteamReviewNotes.instance;
  }

  initialize(client: Client): void {
    this.client = client;
    logger.info(
      `📓 Steam review notes: watching channel ${STEAM_REVIEWS_CHANNEL_ID}, notes at ${NOTES_PATH}, every ${POLL_INTERVAL_MS / 60000}min`
    );
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => logger.error('📓 Steam review cycle failed:', err));
    }, POLL_INTERVAL_MS);
    // First cycle shortly after boot (give the gateway a moment to settle)
    setTimeout(() => {
      this.runCycle().catch((err) => logger.error('📓 Steam review first cycle failed:', err));
    }, 15_000);
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Notes file plumbing
  // ---------------------------------------------------------------------------

  private notesFullPath(): string {
    // Repo root, not package cwd: pm2 runs this service with cwd packages/discord, but the
    // <readfile> capability (packages/capabilities/src/capabilities/development/filesystem.ts)
    // resolves paths from resolve(cwd, '../..') — the doc must land where Artie can read it.
    return join(process.cwd(), '..', '..', NOTES_PATH);
  }

  private readNotes(): string {
    const p = this.notesFullPath();
    if (!existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, SKELETON, 'utf-8');
      return SKELETON;
    }
    return readFileSync(p, 'utf-8');
  }

  private getCursor(notes: string): string {
    return notes.match(CURSOR_RE)?.[1] ?? '0';
  }

  private setCursor(notes: string, id: string): string {
    return notes.replace(CURSOR_RE, `<!-- cursor:${id} -->`);
  }

  private appendToLog(notes: string, lines: string[]): string {
    const idx = notes.indexOf(LOG_END);
    if (idx === -1) {
      logger.warn('📓 Notes file missing log end marker — recreating from skeleton');
      return this.appendToLog(SKELETON, lines);
    }
    return notes.slice(0, idx) + lines.map((l) => l + '\n').join('') + notes.slice(idx);
  }

  private getLogSection(notes: string): string {
    const start = notes.indexOf(LOG_START);
    const end = notes.indexOf(LOG_END);
    if (start === -1 || end === -1) return '';
    return notes.slice(start + LOG_START.length, end).trim();
  }

  private getAnalysisSection(notes: string): string {
    const start = notes.indexOf(ANALYSIS_START);
    const end = notes.indexOf(ANALYSIS_END);
    if (start === -1 || end === -1) return '';
    return notes.slice(start + ANALYSIS_START.length, end).trim();
  }

  private replaceAnalysis(notes: string, analysis: string): string {
    const start = notes.indexOf(ANALYSIS_START);
    const end = notes.indexOf(ANALYSIS_END);
    if (start === -1 || end === -1) return notes;
    return (
      notes.slice(0, start + ANALYSIS_START.length) + '\n' + analysis.trim() + '\n' + notes.slice(end)
    );
  }

  private updateTally(notes: string): string {
    const log = this.getLogSection(notes);
    const up = (log.match(/^- .*?👍/gm) || []).length;
    const down = (log.match(/^- .*?👎/gm) || []).length;
    const total = up + down;
    const pct = total > 0 ? Math.round((up / total) * 100) : 0;
    const line =
      total > 0
        ? `**Tally:** 👍 ${up} · 👎 ${down} — ${total} total, ${pct}% positive _(auto-counted from #steam-reviews)_`
        : `**Tally:** (no reviews logged yet)`;
    return notes.replace(/^\*\*Tally:\*\*.*$/m, line);
  }

  // ---------------------------------------------------------------------------
  // Discord fetching + parsing
  // ---------------------------------------------------------------------------

  /** Parse a Steamy-bot embed message into a review entry, or null if it isn't one. */
  private parseReview(msg: Message): ReviewEntry | null {
    if (!msg.author.bot || msg.embeds.length === 0) return null;
    const embed = msg.embeds[0];
    const title = embed.title || '';
    if (!/review/i.test(title)) return null;

    const verdict: ReviewEntry['verdict'] = /negative|👎/i.test(title)
      ? '👎'
      : /positive|👍/i.test(title)
        ? '👍'
        : '❓';
    const field = (name: RegExp): string =>
      embed.fields.find((f) => name.test(f.name))?.value || '?';
    // Essay-length reviews get truncated in the log — a handful of untruncated ones
    // blew the analysis prompt past the capabilities body limit (413).
    let text = (embed.description || '(no text)').replace(/\s+/g, ' ').trim();
    if (text.length > 600) text = text.slice(0, 600) + '… [truncated]';
    const d = msg.createdAt.toISOString();
    return {
      date: `${d.slice(0, 10)} ${d.slice(11, 16)}`,
      verdict,
      hours: field(/hours/i),
      language: field(/language/i),
      text,
    };
  }

  private formatLogLine(r: ReviewEntry): string {
    return `- ${r.date} ${r.verdict} (${r.hours}, ${r.language}): "${r.text}"`;
  }

  /** Fetch all messages after the cursor, oldest→newest, capped per cycle. */
  private async fetchNewMessages(channel: TextChannel, cursor: string): Promise<Message[]> {
    const collected: Message[] = [];
    let after = cursor;
    while (collected.length < MAX_MESSAGES_PER_CYCLE) {
      const batch = await channel.messages.fetch({ after, limit: 100 });
      if (batch.size === 0) break;
      const asc = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      collected.push(...asc);
      after = asc[asc.length - 1].id;
      if (batch.size < 100) break;
    }
    return collected;
  }

  // ---------------------------------------------------------------------------
  // Main cycle
  // ---------------------------------------------------------------------------

  async runCycle(): Promise<void> {
    if (this.running || !this.client) return; // no overlapping cycles
    this.running = true;
    try {
      const channel = (await this.client.channels
        .fetch(STEAM_REVIEWS_CHANNEL_ID)
        .catch(() => null)) as TextChannel | null;
      if (!channel || !('messages' in channel)) {
        logger.warn(`📓 Steam reviews channel ${STEAM_REVIEWS_CHANNEL_ID} not accessible`);
        return;
      }

      let notes = this.readNotes();
      const cursor = this.getCursor(notes);
      const messages = await this.fetchNewMessages(channel, cursor);

      const reviews: ReviewEntry[] = [];
      for (const msg of messages) {
        const review = this.parseReview(msg);
        if (review) {
          reviews.push(review);
        } else if (!msg.author.bot && msg.content.trim() && !isBlockedUser(msg.author.id)) {
          // Human chatter: carried in memory into the next analysis as community-reaction
          // context, never persisted to the log (the log is reviews only).
          this.chatterBuffer.push(
            `${msg.author.username}: ${msg.content.replace(/\s+/g, ' ').slice(0, 300)}`
          );
        }
      }
      if (this.chatterBuffer.length > CHATTER_BUFFER_MAX) {
        this.chatterBuffer = this.chatterBuffer.slice(-CHATTER_BUFFER_MAX);
      }

      if (reviews.length > 0) {
        notes = this.appendToLog(notes, reviews.map((r) => this.formatLogLine(r)));
        notes = this.updateTally(notes);
        // warn-level: prod console hides info, and new reviews are worth seeing in the log
        logger.warn(`📓 Logged ${reviews.length} new Steam review(s) (${messages.length} msgs scanned)`);
      }
      if (messages.length > 0) {
        notes = this.setCursor(notes, messages[messages.length - 1].id);
        writeFileSync(this.notesFullPath(), notes, 'utf-8');
      }

      if (reviews.length > 0) this.analysisPending = true;
      const analysisDue = Date.now() - this.lastAnalysisAt > ANALYSIS_MIN_INTERVAL_MS;
      if (this.analysisPending && analysisDue && this.getLogSection(notes)) {
        await this.refreshAnalysis(notes);
      }
    } finally {
      this.running = false;
    }
  }

  private async refreshAnalysis(notes: string): Promise<void> {
    const fullLog = this.getLogSection(notes);
    // Hard cap the prompt: express.json() on capabilities defaults to a 100kb body limit,
    // and the log grows forever. Older reviews live on in the tally + previous analysis.
    const LOG_PROMPT_MAX = 60_000;
    const log =
      fullLog.length > LOG_PROMPT_MAX
        ? '(…earlier reviews omitted — totals are in the tally, themes carried in previous analysis)\n' +
          fullLog.slice(fullLog.length - LOG_PROMPT_MAX).replace(/^[^\n]*\n/, '')
        : fullLog;
    const tally = notes.match(/^\*\*Tally:\*\*.*$/m)?.[0] || '';
    const prev = this.getAnalysisSection(notes);
    const chatter = this.chatterBuffer.join('\n') || '(none captured this window)';

    const prompt = `You are Artie, keeping a private intelligence notebook on how Subway Builder's Steam launch (Jul 17 2026) is being received. This document is for EJ and Colin — be honest, specific, and useful, not promotional.

${tally}

REVIEW LOG (oldest first):
${log || '(empty)'}

RECENT COMMUNITY DISCUSSION in #steam-reviews (players reacting to the reviews):
${chatter}

YOUR PREVIOUS ANALYSIS (carry forward whatever is still true):
${prev || '(none yet)'}

Rewrite the full "Situation Analysis" section. Be detailed and concrete:
- Recurring themes in the reviews, each with a rough count and whether it's growing (e.g. "performance/optimization complaints: 4 reviews, 3 in the last day")
- Sentiment trajectory: is the positive ratio holding, improving, or slipping? Anything that changed recently?
- 3-5 representative short quotes, each tagged with its date and 👍/👎
- What the community discussion adds (are players pushing back on negative reviews? echoing them?)
- Notable outliers: unusually detailed, unusually harsh, or unusually glowing reviews worth reading in full
- Flags for EJ & Colin: concrete, actionable observations (a fixable complaint pattern, a misunderstanding the store page could address, etc.)

Output ONLY the markdown body of the section — no top-level heading, no code fences, no preamble.`;

    try {
      const response = await fetch(`${this.CAPABILITIES_URL}/api/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          guildId: '1420846272545296470',
          channelId: STEAM_REVIEWS_CHANNEL_ID,
          messageCount: this.chatterBuffer.length,
        }),
      });
      if (!response.ok) {
        logger.warn(`📓 Analysis refresh failed: ${response.status} ${response.statusText}`);
        return;
      }
      const result = (await response.json()) as { summary: string; cost: number };
      if (!result.summary?.trim()) {
        logger.warn('📓 Analysis refresh returned empty summary — keeping previous analysis');
        return;
      }
      const stamped = `_Last updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_\n\n${result.summary.trim()}`;
      // Re-read: the cycle may have written cursor/log updates after our snapshot
      const fresh = this.readNotes();
      writeFileSync(this.notesFullPath(), this.replaceAnalysis(fresh, stamped), 'utf-8');
      this.lastAnalysisAt = Date.now();
      this.analysisPending = false;
      this.chatterBuffer = [];
      logger.warn(`📓 Steam review situation analysis refreshed (est. $${result.cost?.toFixed(4)})`);
    } catch (error) {
      logger.error('📓 Analysis refresh error:', error);
    }
  }
}

export const steamReviewNotes = SteamReviewNotes.getInstance();


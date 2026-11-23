/**
 * Scribe mode's transcript store: one row per meeting session (`scribe_sessions`) and one row
 * per transcribed utterance (`scribe_utterances`). Text only — audio is never persisted
 * (voice/scribe-session.ts discards each utterance's PCM/WAV buffer as soon as the engine's
 * STT call returns).
 *
 * `CREATE TABLE IF NOT EXISTS`, created lazily on first use — same idiom as
 * shared/privacy-opt-out.ts and shared/pending-actions.ts, not a drizzle migration.
 *
 * Retention: sweepExpiredScribeData() deletes anything older than SCRIBE_RETENTION_DAYS (env,
 * default 7). Called on every new session start (engine/jobs/scribe/orchestrator.ts), so a
 * quiet period doesn't leave a transcript sitting around indefinitely with no scheduler wired
 * up.
 */
import { getSyncDb } from './client.js';

export type ScribeSessionStatus = 'active' | 'stopped' | 'error';

export interface ScribeSession {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
  status: ScribeSessionStatus;
  startedAt: string;
  endedAt: string | null;
  audioSecondsUsed: number;
  sttCostUsd: number;
  capped: boolean;
  summary: string | null;
  pendingActionIds: number[];
  stopReason: string | null;
}

export interface ScribeUtterance {
  id: number;
  sessionId: string;
  speakerId: string;
  displayName: string;
  text: string;
  ts: string;
  durationSeconds: number;
}

let tableReady = false;

function ensureTables(): void {
  if (tableReady) return;
  const db = getSyncDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS scribe_sessions (
      session_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      voice_channel_id TEXT NOT NULL,
      text_channel_id TEXT NOT NULL,
      started_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      audio_seconds_used REAL NOT NULL DEFAULT 0,
      stt_cost_usd REAL NOT NULL DEFAULT 0,
      capped INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      pending_action_ids TEXT NOT NULL DEFAULT '[]',
      stop_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scribe_sessions_guild ON scribe_sessions(guild_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scribe_sessions_created ON scribe_sessions(created_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS scribe_utterances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      speaker_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      text TEXT NOT NULL,
      ts TEXT NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scribe_utterances_session ON scribe_utterances(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scribe_utterances_created ON scribe_utterances(created_at)`);
  tableReady = true;
}

interface SessionRow {
  session_id: string;
  guild_id: string;
  voice_channel_id: string;
  text_channel_id: string;
  started_by: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  audio_seconds_used: number;
  stt_cost_usd: number;
  capped: number;
  summary: string | null;
  pending_action_ids: string;
  stop_reason: string | null;
}

function parsePendingIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((n) => typeof n === 'number');
    }
    return [];
  } catch {
    return [];
  }
}

function fromRow(r: SessionRow): ScribeSession {
  return {
    sessionId: r.session_id,
    guildId: r.guild_id,
    voiceChannelId: r.voice_channel_id,
    textChannelId: r.text_channel_id,
    startedBy: r.started_by,
    status: r.status as ScribeSessionStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    audioSecondsUsed: r.audio_seconds_used,
    sttCostUsd: r.stt_cost_usd,
    capped: r.capped === 1,
    summary: r.summary,
    pendingActionIds: parsePendingIds(r.pending_action_ids),
    stopReason: r.stop_reason,
  };
}

export function createScribeSession(input: {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
}): void {
  ensureTables();
  getSyncDb().run(
    `INSERT INTO scribe_sessions (session_id, guild_id, voice_channel_id, text_channel_id, started_by, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [
      input.sessionId,
      input.guildId,
      input.voiceChannelId,
      input.textChannelId,
      input.startedBy,
      new Date().toISOString(),
    ]
  );
}

export function getScribeSession(sessionId: string): ScribeSession | null {
  ensureTables();
  const row = getSyncDb().get<SessionRow>(`SELECT * FROM scribe_sessions WHERE session_id = ?`, [
    sessionId,
  ]);
  if (row) return fromRow(row);
  return null;
}

export function getActiveScribeSessionForGuild(guildId: string): ScribeSession | null {
  ensureTables();
  const row = getSyncDb().get<SessionRow>(
    `SELECT * FROM scribe_sessions WHERE guild_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [guildId]
  );
  if (row) return fromRow(row);
  return null;
}

/** The most recent finished session in this guild (the scribe tool's "last time"). */
export function getLastFinishedScribeSession(guildId: string): ScribeSession | null {
  ensureTables();
  const row = getSyncDb().get<SessionRow>(
    `SELECT * FROM scribe_sessions WHERE guild_id = ? AND status != 'active' ORDER BY created_at DESC LIMIT 1`,
    [guildId]
  );
  if (row) return fromRow(row);
  return null;
}

/** Add to the running audio-seconds/cost totals. Returns the session's new total seconds. */
export function addScribeUsage(sessionId: string, deltaSeconds: number, deltaCostUsd: number): number {
  ensureTables();
  const db = getSyncDb();
  db.run(
    `UPDATE scribe_sessions SET audio_seconds_used = audio_seconds_used + ?, stt_cost_usd = stt_cost_usd + ? WHERE session_id = ?`,
    [deltaSeconds, deltaCostUsd, sessionId]
  );
  const row = db.get<{ audio_seconds_used: number }>(
    `SELECT audio_seconds_used FROM scribe_sessions WHERE session_id = ?`,
    [sessionId]
  );
  return row?.audio_seconds_used ?? deltaSeconds;
}

export function markScribeSessionCapped(sessionId: string): void {
  ensureTables();
  getSyncDb().run(`UPDATE scribe_sessions SET capped = 1 WHERE session_id = ?`, [sessionId]);
}

export function finishScribeSession(
  sessionId: string,
  input: { summary: string; pendingActionIds: number[]; stopReason: string; status?: 'stopped' | 'error' }
): void {
  ensureTables();
  getSyncDb().run(
    `UPDATE scribe_sessions SET status = ?, ended_at = ?, summary = ?, pending_action_ids = ?, stop_reason = ? WHERE session_id = ?`,
    [
      input.status ?? 'stopped',
      new Date().toISOString(),
      input.summary,
      JSON.stringify(input.pendingActionIds),
      input.stopReason,
      sessionId,
    ]
  );
}

/**
 * Boot reconcile: no voice session survives a process restart, so any row still 'active' was
 * left by a crash or a shutdown that ran out of time. Left alone it stays 'active' forever and
 * getActiveScribeSessionForGuild keeps returning it (2026-10-31). Returns how many it closed.
 * The transcript stays for the retention window; only the summary is lost.
 */
export function endCrashedScribeSessions(): number {
  ensureTables();
  const result = getSyncDb().run(
    `UPDATE scribe_sessions SET status = 'error', stop_reason = 'crash', ended_at = ? WHERE status = 'active'`,
    [new Date().toISOString()]
  );
  return result.changes;
}

export function appendScribeUtterance(input: {
  sessionId: string;
  speakerId: string;
  displayName: string;
  text: string;
  ts: string;
  durationSeconds: number;
}): void {
  ensureTables();
  getSyncDb().run(
    `INSERT INTO scribe_utterances (session_id, speaker_id, display_name, text, ts, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.sessionId, input.speakerId, input.displayName, input.text, input.ts, input.durationSeconds]
  );
}

export function listScribeUtterances(sessionId: string): ScribeUtterance[] {
  ensureTables();
  const rows = getSyncDb().all<{
    id: number;
    session_id: string;
    speaker_id: string;
    display_name: string;
    text: string;
    ts: string;
    duration_seconds: number;
  }>(`SELECT * FROM scribe_utterances WHERE session_id = ? ORDER BY ts ASC`, [sessionId]);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    speakerId: r.speaker_id,
    displayName: r.display_name,
    text: r.text,
    ts: r.ts,
    durationSeconds: r.duration_seconds,
  }));
}

export function scribeRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.SCRIBE_RETENTION_DAYS || '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  return 7;
}

/** Delete sessions (and their utterances) older than the retention window. Text only; there's
 *  never any audio in these tables to begin with. Safe to call often — it's a no-op when
 *  nothing has aged out. */
export function sweepExpiredScribeData(retentionDays: number = scribeRetentionDays()): {
  sessionsDeleted: number;
  utterancesDeleted: number;
} {
  ensureTables();
  const db = getSyncDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const expired = db.all<{ session_id: string }>(
    `SELECT session_id FROM scribe_sessions WHERE created_at < ?`,
    [cutoff]
  );
  if (expired.length === 0) {
    return { sessionsDeleted: 0, utterancesDeleted: 0 };
  }
  let utterancesDeleted = 0;
  for (const { session_id } of expired) {
    const result = db.run(`DELETE FROM scribe_utterances WHERE session_id = ?`, [session_id]);
    utterancesDeleted += result.changes ?? 0;
  }
  const sessionsResult = db.run(`DELETE FROM scribe_sessions WHERE created_at < ?`, [cutoff]);
  return { sessionsDeleted: sessionsResult.changes ?? 0, utterancesDeleted };
}

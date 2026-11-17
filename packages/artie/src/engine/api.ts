/**
 * The engine's in-process API: the ONLY engine module the gateway may import
 * (tests/architecture.test.ts, wave 9).
 *
 * Before wave 9 the gateway reached the engine over loopback HTTP (:47324). Each function
 * here calls the same handler body that route calls and returns that route's
 * `{ status, body }`, so the gateway reads `.status` / `.body` where it read
 * `response.status` / `await response.json()`. The HTTP routes still exist for external
 * callers (mesh bridges, brain, GitHub, scripts) and run the same code.
 *
 * Bodies go through `wire()` (a JSON round trip), so a handler sees exactly what the HTTP
 * route would have parsed.
 *
 * Engine modules are imported lazily, so the gateway's module graph never pulls the engine's
 * in at load (no import cycles through module-level bindings, and gateway unit tests that
 * import a watcher don't boot the tool registry).
 */
import { type ApiResult, wire } from '../shared/api-result.js';
import type { JsonOutputSpec } from '../shared/structured-output.js';
import type { ScribeSession } from '../shared/db/scribe-store.js';

export type { ApiResult } from '../shared/api-result.js';
export { isOk, statusText } from '../shared/api-result.js';

const chat = () => import('./1-intake/chat-route.js');

// --- turns (was POST :47324/chat, GET /chat/:id, /chat/:id/stream, /chat/pending-attachments) ---

export interface TurnRequest {
  message: string;
  userId?: string;
  context?: Record<string, any>;
  source?: string;
  [extra: string]: unknown;
}

/**
 * Queue one turn (POST /chat). With `wait`, resolve once it finishes or after 2 minutes
 * (POST /chat?wait=true). Not rate-limited: that limiter is the HTTP route's, per client IP.
 */
export async function submitTurn(request: TurnRequest, opts: { wait?: boolean } = {}): Promise<ApiResult> {
  return (await chat()).submitTurn(wire(request), { wait: opts.wait });
}

/** A turn's status/result (GET /chat/:id); status 404 once the job tracker has dropped it. */
export async function getTurn(messageId: string): Promise<ApiResult> {
  return (await chat()).getTurn({ messageId });
}

/**
 * Follow a turn the way GET /chat/:id/stream does: 'status' first, then 'progress' /
 * 'complete' / 'timeout' / 'error' events from a 500ms poll of the job tracker, then `end`.
 */
export async function watchTurn(
  messageId: string,
  onEvent: (event: string, data: any) => void,
  end: () => void
): Promise<void> {
  (await chat()).watchTurn(messageId, onEvent, end);
}

/** Take (and clear) the files a turn queued, keyed by turn id (GET /chat/pending-attachments/:turnId). */
export async function pendingAttachments(turnId: string): Promise<ApiResult> {
  return (await chat()).takePendingAttachments({ turnId });
}

const pendingComponentsStore = () => import('./1-intake/pending-components.js');

/**
 * Take (and clear) the Discord component rows (buttons/select) a turn queued via the
 * discord-ui tool. Not an HTTP route — only the gateway's stream-reply.ts calls this, keyed
 * by the turn id (jobInfo.messageId), right after the final reply, to attach them to the
 * message it just sent.
 */
export async function pendingComponents(turnId: string): Promise<ApiResult> {
  const { takePendingComponents } = await pendingComponentsStore();
  return { status: 200, body: { success: true, rows: takePendingComponents(turnId) } };
}

/**
 * Current brownout mode/runway (engine/budget/brownout.ts), for the gateway's component-click
 * cap: a click under `critical` brownout gets an ephemeral "running lean" instead of a paid
 * LLM turn. Not an HTTP route.
 */
export async function brownoutStatus(): Promise<ApiResult> {
  const { getBrownoutMode } = await import('./budget/brownout.js');
  const status = await getBrownoutMode();
  return { status: 200, body: status };
}

// --- background work the gateway asks for ---

/** POST /api/observe: a FAST_MODEL observation summary ({summary, cost}). */
export async function observe(body: {
  prompt: string;
  guildId?: string;
  channelId?: string;
  messageCount?: number;
  timeRange?: unknown;
}): Promise<ApiResult> {
  return (await import('./routes/observe.js')).observe(wire(body));
}

/** A ≤12-word data-dense summary for a GitHub card (null → show the plain title). */
export async function githubHeadline(req: {
  key: string;
  kind: string;
  title: string;
  body?: string;
  guildId?: string;
}): Promise<string | null> {
  return (await import('./jobs/github-headline.js')).githubHeadline(wire(req));
}

/** POST /api/channel-digest: fold new lines into a channel's rolling digest. */
export async function channelDigest(body: any): Promise<ApiResult> {
  return (await import('./routes/channel-digest.js')).channelDigest(wire(body));
}

/** POST /api/route-repo: Artie picks the Discord channel for a newly found repo. */
export async function routeRepo(body: any): Promise<ApiResult> {
  return (await import('./routes/route-repo.js')).routeRepo(wire(body));
}

/** POST /api/reflection/check-threshold: emergency reflection after a burst of 👎. */
export async function checkReflectionThreshold(body: {
  guildId: string;
  threshold: number;
  hours?: number;
}): Promise<ApiResult> {
  return (await import('./routes/reflection.js')).checkReflectionThreshold(wire(body));
}

/** POST /capabilities/registry/:name/execute: run one tool action directly (no LLM). */
export async function executeTool(
  name: string,
  body: { action: string; params?: Record<string, unknown>; content?: string; [k: string]: unknown }
): Promise<ApiResult> {
  return (await import('./routes/tool-registry.js')).executeTool({ name }, wire(body));
}

/** POST /api/traces/link-discord: tie a Discord reply to its generation trace. */
export async function linkDiscordMessage(body: { jobId: string; discordMessageId: string }): Promise<ApiResult> {
  return (await import('./routes/observability.js')).linkDiscordMessage(wire(body));
}

/** POST /api/traces/feedback: a 👍/👎 reaction against the reply's trace. */
export async function recordTraceFeedback(body: {
  discordMessageId: string;
  sentiment: 'positive' | 'negative';
  emoji: string;
}): Promise<ApiResult> {
  return (await import('./routes/observability.js')).recordTraceFeedback(wire(body));
}

// --- scribe mode (voice meeting scribe) — gateway/voice/scribe-session.ts owns the
//     VoiceConnection; everything STT/storage/summary/GitHub-shaped lives engine-side
//     (engine/jobs/scribe/orchestrator.ts). ---

const scribe = () => import('./jobs/scribe/orchestrator.js');

/** Brownout check before joining — refuses to start when credit runway is critical. */
export async function scribeCanStart(): Promise<{ allowed: boolean; reason?: string }> {
  return (await scribe()).scribeCanStart();
}

/** Create the DB session row (and run the retention sweep) once the gateway has joined. */
export async function scribeStart(body: {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedBy: string;
  summaryOnly?: boolean;
}): Promise<{ sessionId: string }> {
  return (await scribe()).startScribeSession(wire(body));
}

/** One utterance: base64 WAV in, STT + usage-ledger recording + transcript row out. */
export async function scribeSubmitUtterance(body: {
  sessionId: string;
  userId: string;
  displayName: string;
  wavBase64: string;
  startedAt: string;
  durationSeconds: number;
}): Promise<{ accepted: boolean; text?: string; reason?: string }> {
  return (await scribe()).submitScribeUtterance(wire(body));
}

/** Summary LLM call, gated GitHub proposals, and posting the result — all engine-side. */
export async function scribeStop(
  sessionId: string,
  stopReason: string
): Promise<{ pendingCount: number; textChannelId: string; capped: boolean; posted: boolean }> {
  return (await scribe()).stopScribeSession(sessionId, stopReason);
}

/** The active session row for a guild (or null), for /scribe status. */
export async function scribeStatus(guildId: string): Promise<ScribeSession | null> {
  return (await scribe()).getScribeStatus(guildId);
}

// --- status (slash commands, the gateway's readiness check) ---

/** GET /health: 200 when the engine's Redis answers, else 503. */
export async function healthSnapshot(): Promise<ApiResult> {
  return (await import('./routes/health.js')).healthSnapshot();
}

/** GET /api/models: the model pool with live OpenRouter data. */
export async function models(): Promise<ApiResult> {
  return (await import('./routes/models.js')).listModels();
}

/** GET /capabilities: the tool registry and its stats. */
export async function capabilities(): Promise<ApiResult> {
  return (await import('./routes/tool-registry.js')).listCapabilities();
}

// --- model catalog (wave 10; not an HTTP route) ---

/**
 * `response_format` for a direct OpenRouter call the gateway makes itself (the ambient
 * judgment), or undefined: the same per-model rule generateTurn applies (openrouter.ts
 * responseFormatForModel). The caller still parses the reply with parseModelJson.
 */
export async function responseFormatForModel(
  model: string,
  spec: JsonOutputSpec
): Promise<Record<string, unknown> | undefined> {
  return (await import('./4-generate/openrouter.js')).responseFormatForModel(model, spec);
}

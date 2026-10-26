/**
 * Shared shapes for the scribe pipeline (engine side). Not a tool, not a capability — this is
 * the "job" register-tools.ts/the architecture test don't need to know about (tests/
 * architecture.test.ts's rule 4 is scoped to engine/tools/**, not engine/jobs/**, matching the
 * precedent of engine/jobs/github-push).
 */

export interface ScribeUtteranceInput {
  sessionId: string;
  userId: string;
  displayName: string;
  /** Base64-encoded WAV bytes (mono PCM16). Crosses the gateway->engine seam as a string
   *  because engine/api.ts's wire() does a JSON round trip — raw Buffers don't survive that. */
  wavBase64: string;
  startedAt: string; // ISO timestamp of the utterance start
  /** Computed by the gateway (gateway/voice/wav.ts's pcmDurationSeconds) before it wraps and
   *  base64-encodes the PCM — cheaper than re-parsing the WAV header back out engine-side. */
  durationSeconds: number;
}

export interface ScribeProposal {
  kind: 'create' | 'update';
  repo: string;
  title: string;
  body: string;
  issueNumber?: number;
}

export interface ScribeSummaryResult {
  summaryText: string;
  proposals: ScribeProposal[];
}

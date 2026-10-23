/**
 * The reply budget, in ONE place.
 *
 * It used to live in two, and they disagreed: consumer.ts said 120s and llm-loop-service.ts
 * said 120s independently, so raising one to 180s changed nothing — the loop's own copy was
 * the binding constraint and kept guillotining the model-fallback chain. Two constants that
 * must agree WILL drift; the only fix that sticks is not having two.
 *
 * The invariant, which must hold or replies die:
 *
 *   (models tried) * PER_REQUEST  <  LLM_LOOP  <  JOB
 *        3 * 45s = 135s           <   150s     <  180s
 *
 * Why the ordering matters:
 * - PER_REQUEST bounds ONE model attempt. Without it the OpenAI SDK defaults to 600s with 2
 *   retries, so a single wedged provider eats the entire budget and every reply goes silent.
 * - LLM_LOOP is a SOFT deadline. The loop stops starting new iterations and returns its best
 *   answer so far. It must be the first limit hit, because it's the only one that still
 *   produces words.
 * - JOB is the HARD backstop in the consumer. Hitting it means something is genuinely wedged;
 *   it throws, and the user gets nothing. It exists to free the worker, not to shape replies.
 *
 * If you add models to OPENROUTER_MODELS or raise the exploration depth, redo the arithmetic.
 * When it stops holding, the symptom is not a slow bot — it's a silent one.
 */
export const PER_REQUEST_TIMEOUT_MS = 45_000;
export const LLM_LOOP_TIMEOUT_MS = 150_000;
export const JOB_TIMEOUT_MS = 180_000;

/**
 * How far AHEAD of the hard JOB kill the soft deadline sits (context.deadlineAt).
 *
 * A duration alone wasn't enough: LLM_LOOP_TIMEOUT_MS was measured from when the LOOP
 * started, while JOB_TIMEOUT_MS was measured from when the JOB started. The gap between
 * those two zero points (context building, first LLM call, capability execution) meant the
 * "soft" deadline could land after the hard one and never fire at all — observed in prod:
 * a job died on the 180s kill having never once logged the soft deadline.
 *
 * So the deadline is absolute and stamped at job start. This reserve is the headroom left
 * to actually deliver the salvaged answer — finish the in-flight call, strip tags, enqueue
 * the reply — after we stop starting new work.
 */
export const SOFT_DEADLINE_RESERVE_MS = 30_000;

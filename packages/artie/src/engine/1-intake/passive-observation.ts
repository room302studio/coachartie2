import type { IncomingMessage } from '@coachartie/shared';

/**
 * PASSIVE DISCORD OBSERVATION DOES NOT GENERATE (#88).
 *
 * Every unaddressed message in a coach-artie channel is published to the incoming queue with
 * shouldRespond=false, and the worker used to run the FULL orchestration on it — persona
 * model, capabilities, the lot — and then discard the reply ("Passive observation completed
 * ... no response queued"). A paid generation per message nobody asked Artie about; very
 * likely the bulk of #88's "96% of generations were on messages that never addressed him".
 * Passive observation only needs the message stored for channel history, which the worker
 * does before this check. PASSIVE_OBSERVATION_GENERATE=true restores the old behaviour.
 *
 * Non-Discord shouldRespond=false traffic (e.g. the reddit monitor, which wants capabilities
 * to act without replying) is unaffected.
 */
export function shouldSkipPassiveGeneration(
  message: Pick<IncomingMessage, 'source' | 'context'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.PASSIVE_OBSERVATION_GENERATE === 'true') return false;
  if (message.context?.shouldRespond !== false) return false;
  return message.source === 'discord' || message.context?.platform === 'discord';
}

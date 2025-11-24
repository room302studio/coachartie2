/**
 * Capability Signature Emojis
 *
 * Visual indicators for capability execution using Discord reactions.
 * Each capability defines its own emoji in its manifest - this just provides
 * the default fallback.
 */

export const DEFAULT_CAPABILITY_EMOJI = '⚙️';


/**
 * Thinking/processing flutter sequence
 * Rapidly cycle through these while processing, before capability is determined
 */
export const THINKING_FLUTTER = ['💭', '🤔', '💡', '⚡', '✨'];

/**
 * Activity indicators for different states
 */
export const ACTIVITY_INDICATORS = {
  thinking: ['💭', '🤔', '🧠'],
  processing: ['⚙️', '🔄', '⚡'],
  searching: ['🔍', '🔎', '🌐'],
  calculating: ['🧮', '📊', '💫'],
};

/**
 * React with a flutter effect, then settle on final emoji
 * @param reactFn Function to add a reaction
 * @param unreactFn Function to remove a reaction
 * @param finalEmoji The capability signature to settle on
 * @param flutterMs How long to flutter (default 800ms)
 */
export async function flutterReaction(
  reactFn: (emoji: string) => Promise<void>,
  unreactFn: (emoji: string) => Promise<void>,
  finalEmoji: string,
  flutterMs: number = 800
): Promise<void> {
  const sequence = THINKING_FLUTTER;
  const interval = flutterMs / sequence.length;

  // Flutter through thinking emojis
  for (const emoji of sequence) {
    await reactFn(emoji);
    await new Promise((resolve) => setTimeout(resolve, interval));
    await unreactFn(emoji);
  }

  // Settle on the final capability signature
  await reactFn(finalEmoji);
}

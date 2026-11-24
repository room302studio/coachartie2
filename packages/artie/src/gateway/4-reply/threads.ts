/**
 * Threads: when a request deserves its own thread, what to call it, and the status embed.
 * Moved verbatim out of stream-reply.ts (wave 5). Threading is off by default and no caller
 * turns it on; createStatusEmbed has no caller today.
 */

/**
 * Determine if content warrants a thread
 * Simple heuristic: long messages or multiple questions get threads
 */
export function shouldCreateThread(content: string): boolean {
  // Create threads for long requests or multiple questions
  // No keyword heuristics - just length-based
  return content.length > 200 || content.split('?').length > 2;
}

/**
 * Generate a friendly thread name from content
 * Simple approach: first few words
 */
export function generateThreadName(content: string): string {
  // Just use first few words - no keyword heuristics
  const truncated = content.slice(0, 80);
  const words = truncated.split(' ').slice(0, 8);
  let ellipsis: string;
  if (content.length > 80) {
    ellipsis = '...';
  } else {
    ellipsis = '';
  }
  return words.join(' ') + ellipsis;
}


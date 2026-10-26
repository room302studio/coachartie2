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

/**
 * Create rich Discord embed for status updates
 */
export function createStatusEmbed(
  status: string,
  jobId: string,
  startTime: number,
  streamedChunks: number = 0
) {
  const duration = Date.now() - startTime;
  const statusColors: Record<string, number> = {
    pending: 0xffa500, // Orange
    processing: 0x3498db, // Blue
    completed: 0x2ecc71, // Green
    error: 0xe74c3c, // Red
  };

  const statusEmojis: Record<string, string> = {
    pending: '⏸️',
    processing: '⚡',
    completed: '✅',
    error: '❌',
  };

  return {
    color: statusColors[status] || statusColors.pending,
    title: `${statusEmojis[status] || '🤖'} Coach Artie Status`,
    fields: [
      {
        name: 'Status',
        value: status.charAt(0).toUpperCase() + status.slice(1),
        inline: true,
      },
      {
        name: 'Duration',
        value: `${Math.round(duration / 1000)}s`,
        inline: true,
      },
      {
        name: 'Job ID',
        value: `\`${jobId.slice(-8)}\``,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: (() => {
      let text: string;
      if (streamedChunks > 0) {
        text = `${streamedChunks} chunks streamed`;
      } else {
        text = 'Processing your request...';
      }
      return { text };
    })(),
  };
}

/**
 * Splitting text into Discord-sized messages.
 *
 * This lived in THREE copies (queues/consumer.ts, handlers/message-handler.ts,
 * handlers/reaction-handler.ts) which had drifted apart: only message-handler's was
 * code-block aware, so the same text chunked differently depending on which path sent
 * it. All three shared one trap — they returned `[]` for empty input, and `[]` is
 * silent. Each caller got it wrong differently:
 *   - the outgoing consumer iterated it, sent nothing, and logged "Response sent"
 *   - message-handler logged "Sending 0 chunks" then threw on chunks[0].length
 *   - reaction-handler passed chunks[0] === undefined straight into reply()
 * so a reply could vanish for weeks while the logs claimed success.
 *
 * This is the code-block-aware version (the superset). The trap is fixed in the TYPE:
 * `null` means "nothing to send" and the success case is a NON-EMPTY tuple, so callers
 * can't iterate past it or index [0] without the compiler objecting, and chunks[0] is
 * statically a string. Unrepresentable beats documented.
 */

/** A guaranteed non-empty list of Discord-sized chunks. */
export type MessageChunks = [string, ...string[]];

export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export function chunkMessage(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH
): MessageChunks | null {
  if (!text || text.trim().length === 0) {
    return null;
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];

  // Step 1: Identify all code blocks and their positions
  interface CodeBlock {
    start: number;
    end: number;
    content: string;
    language?: string;
  }

  const codeBlocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[0],
      language: match[1],
    });
  }

  // Step 2: Split text into segments (code blocks and text between them)
  interface Segment {
    content: string;
    isCodeBlock: boolean;
    start: number;
    end: number;
  }

  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const block of codeBlocks) {
    // Add text before code block
    if (block.start > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, block.start),
        isCodeBlock: false,
        start: lastIndex,
        end: block.start,
      });
    }

    // Add code block
    segments.push({
      content: block.content,
      isCodeBlock: true,
      start: block.start,
      end: block.end,
    });

    lastIndex = block.end;
  }

  // Add remaining text after last code block
  if (lastIndex < text.length) {
    segments.push({
      content: text.slice(lastIndex),
      isCodeBlock: false,
      start: lastIndex,
      end: text.length,
    });
  }

  // Step 3: Build chunks respecting code block boundaries
  let currentChunk = '';

  for (const segment of segments) {
    if (segment.isCodeBlock) {
      // Code block - must be kept intact
      const segmentLength = segment.content.length;

      // If adding this code block would exceed limit, flush current chunk first
      if (currentChunk.length > 0 && currentChunk.length + segmentLength + 1 > maxLength) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If code block itself is too large, handle specially
      if (segmentLength > maxLength) {
        // Flush any pending content first
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Split large code block while maintaining syntax
        // Extract language and content
        const codeMatch = segment.content.match(/```(\w+)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const language = codeMatch[1] || '';
          const codeContent = codeMatch[2];
          const codeLines = codeContent.split('\n');

          let codeChunk = '';
          const opener = `\`\`\`${language}\n`;
          const closer = '\n```';
          const overhead = opener.length + closer.length;

          for (const line of codeLines) {
            const testChunk = codeChunk + (codeChunk ? '\n' : '') + line;

            if (testChunk.length + overhead > maxLength) {
              // Flush current code chunk
              if (codeChunk) {
                chunks.push(opener + codeChunk + closer);
                codeChunk = '';
              }

              // If single line is too long, split it (rare but possible)
              if (line.length + overhead > maxLength) {
                // Split line into smaller pieces
                const safeLength = maxLength - overhead;
                for (let i = 0; i < line.length; i += safeLength) {
                  const piece = line.slice(i, i + safeLength);
                  chunks.push(opener + piece + closer);
                }
              } else {
                codeChunk = line;
              }
            } else {
              codeChunk = testChunk;
            }
          }

          // Flush remaining code
          if (codeChunk) {
            chunks.push(opener + codeChunk + closer);
          }
        } else {
          // Fallback: just truncate with warning
          chunks.push(segment.content.slice(0, maxLength - 20) + '\n... (truncated)');
        }

        continue;
      }

      // Normal-sized code block - add to current chunk
      currentChunk += (currentChunk ? '\n' : '') + segment.content;
    } else {
      // Regular text - preserve newlines while respecting Discord's char limit
      // This is CRITICAL for markdown formatting (headers, lists, paragraphs)
      const textContent = segment.content;

      // Split on double newlines to find paragraphs, but keep the delimiters
      const paragraphParts = textContent.split(/(\n\n+)/);

      for (const part of paragraphParts) {
        // Check if this is a paragraph delimiter (double+ newlines)
        const isDelimiter = /^\n\n+$/.test(part);

        if (isDelimiter) {
          // Preserve paragraph breaks - normalize to double newline
          if (currentChunk.length + 2 <= maxLength) {
            currentChunk += '\n\n';
          } else {
            // Flush and start fresh with the delimiter
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trimEnd());
              currentChunk = '';
            }
          }
          continue;
        }

        // Regular paragraph content - preserve single newlines within it
        const lines = part.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          // Don't trim - preserve leading whitespace for indentation

          // Calculate what we need to add
          const needsNewline = currentChunk.length > 0 && lineIdx > 0;
          const addition = (needsNewline ? '\n' : '') + line;

          // If adding this line fits, add it
          if (currentChunk.length + addition.length <= maxLength) {
            currentChunk += addition;
            continue;
          }

          // Line won't fit - flush current chunk first
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trimEnd());
            currentChunk = '';
          }

          // If line itself fits, use it
          if (line.length <= maxLength) {
            currentChunk = line;
            continue;
          }

          // Line is too long - must split by words
          const words = line.split(' ');

          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxLength) {
              if (currentChunk.trim()) {
                chunks.push(currentChunk.trimEnd());
                currentChunk = '';
              }

              // If single word is too long, split it (rare but possible)
              if (word.length > maxLength) {
                for (let i = 0; i < word.length; i += maxLength) {
                  chunks.push(word.slice(i, i + maxLength));
                }
              } else {
                currentChunk = word;
              }
            } else {
              currentChunk += (currentChunk ? ' ' : '') + word;
            }
          }
        }
      }
    }
  }

  // Flush any remaining content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Non-empty input always yields something: fall back to the raw text rather than
  // reporting "nothing to send" for content we were actually handed.
  return chunks.length > 0 ? (chunks as MessageChunks) : [text];
}

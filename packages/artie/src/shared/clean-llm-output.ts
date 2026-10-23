/**
 * CRITICAL SECURITY: Strip capability XML tags from text before sending to Discord
 *
 * Capability tags like <capability name="tts" action="sing">...</capability>
 * should NEVER appear in Discord messages - they must be processed first.
 *
 * This is a safeguard against accidentally leaking capability XML when messages
 * are sent via non-standard paths (direct Discord API calls, webhooks, etc.)
 */

export function stripCapabilityXML(text: string): string {
  if (!text) return text;

  // Remove all <capability...>...</capability> tags (multiline, greedy)
  // This catches the full tag including content between opening and closing tags
  let stripped = text.replace(/<capability\b[^>]*>[\s\S]*?<\/capability>/gi, '');

  // Also remove any self-closing <capability.../> tags
  stripped = stripped.replace(/<capability\b[^>]*\/>/gi, '');

  // Log if we stripped anything (this should trigger investigation)
  if (stripped !== text) {
    console.error('🚨 CAPABILITY XML LEAKED TO DISCORD - STRIPPED IT:', {
      original_length: text.length,
      stripped_length: stripped.length,
      removed_chars: text.length - stripped.length
    });
  }

  return stripped.trim();
}

/**
 * [SILENT]: the model chose not to speak. A LEADING marker (after whitespace, any case)
 * silences the whole reply even if chatter follows; that is the check every delivery path
 * makes. `exact: true` is the engine's storage filter, which only skips a reply that is
 * nothing BUT the marker (so "[SILENT] chatter" is still stored as a turn).
 */
export function isSilent(text: string, opts: { exact?: boolean } = {}): boolean {
  if (opts.exact) return text.trim() === '[SILENT]' || text.trim().toLowerCase() === '[silent]';
  return /^\s*\[SILENT\]/i.test(text);
}

/**
 * Check if text contains capability XML (for detection without modifying)
 */
export function containsCapabilityXML(text: string): boolean {
  if (!text) return false;
  return /<capability\b[^>]*(?:>[\s\S]*?<\/capability>|\/>;)/i.test(text);
}

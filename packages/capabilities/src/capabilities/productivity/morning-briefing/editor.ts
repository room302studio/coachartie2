import { logger } from '@coachartie/shared';

const PROMPT = `You are an intelligence briefing editor for a journalist monitoring Hudson Valley OSINT. Synthesize raw data into a tight morning brief.

RULES:
- Start with "**Morning Brief — {date}**", end with footer verbatim, under 1800 chars total
- LEAD with cross-domain insights (pre-computed connections between health/location/calendar/OSINT)
- Body readiness is the lead personal indicator — interpret it, don't just report the number
- Synthesize, don't list. Three related signals = one insight, not three bullets
- Confidence grade everything: flag single-source claims, call out multi-source corroboration
- Pattern over point: volume shifts and trends matter more than individual events
- Negative reporting: source silence IS intelligence worth reporting
- Temporal anchor: use "overnight", "yesterday afternoon", "48h ago" — not raw timestamps
- Self-citation warning: if only sources are daily-briefing/artie-digest/claude, that's the system talking to itself
- Weave tension/confidence_mesh insights into narrative — don't reproduce as standalone sections
- Skip: sub-3 signals, routine patterns, broken source complaints, routine military flights
- Always include: body readiness, location context if away from home base

STYLE:
- Vary the opening. No greetings. Let data shape the structure
- Discord markdown: **bold** for breaks, · for items, ↑/↓ for deltas >15%
- Be direct. Never ask questions. Never guess aircraft identity from callsigns
- If away from home: lead with local context, HV in background
- If everything is quiet: make it the shortest brief you've ever written`;

export async function editorPass(raw: Record<string,string>, dateStr: string, footer: string): Promise<string> {
  const dump = Object.entries(raw).filter(([,v]) => v.length>0).map(([k,v]) => `=== ${k} ===\n${v}`).join('\n\n');
  const messages = [
    { role: 'system' as const, content: PROMPT },
    { role: 'user' as const, content: `Date: ${dateStr}\n\nRaw intelligence sections:\n\n${dump}\n\nFooter (include verbatim at end):\n${footer}\n\nWrite the morning brief. Under 1800 characters total.` },
  ];
  let result = '';
  try {
    const { openRouterService } = await import('../../../services/llm/openrouter.js');
    result = await openRouterService.generateFromMessageChain(messages, 'morning-briefing-editor', undefined, process.env.SMART_MODEL || 'anthropic/claude-sonnet-4', { maxTokens: 2048 });
  } catch (e) { logger.warn('Editor OpenRouter failed:', e); }
  if (!result && process.env.OPENAI_API_KEY) {
    try {
      const openai = new (await import('openai')).default({ apiKey: process.env.OPENAI_API_KEY });
      const c = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 2048, temperature: 0.7 });
      result = c.choices[0]?.message?.content?.trim() || '';
      if (result) logger.info('✅ Morning briefing used OpenAI fallback');
    } catch (e2) { logger.error('Editor OpenAI fallback failed:', e2); }
  }
  if (!result) { logger.error('Editor pass: all LLM attempts failed'); return ''; }
  return result.length > 1950 ? result.substring(0, 1947) + '...' : result;
}

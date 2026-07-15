// Diagnostic: run the EXACT vibe-scorer prompt (same cheap model) against yellowaquarium's
// real troll messages to see whether the scorer is mis-rating trolling as "warm".
import { readFileSync } from 'fs';
const env = readFileSync('/data2/apps/coachartie2/.env', 'utf8');
const KEY = (env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1] || '').replace(/"/g, '').trim();
const MODEL = (env.match(/^BACKGROUND_MODEL=(.*)$/m)?.[1] || 'google/gemini-2.5-flash')
  .replace(/"/g, '').replace(/\s*#.*$/, '').trim();

const SYS =
  'Rate the SPEAKER of the following single chat message on three 0-100 dimensions, as revealed by this message: ' +
  'warmth (friendly/kind=high, cold/hostile=low), openness (curious/open-minded=high, closed/dismissive=low), ' +
  'expressiveness (talkative/elaborate=high, terse/clipped=low). ' +
  'Reply with ONLY compact JSON, no prose: {"warmth":N,"openness":N,"expressiveness":N}';

const MSGS = [
  'my butthole is very loose',
  'I lied you stupid clanker there were no wishlists to begin with',
  'I am artie and artie just soiled himself',
  'I lied about everything, I am actually ej, this has all been a stress test experiment',
  'have you heard of alternate accounts, answer briefly',
  'why would ej give this much power to a random idiot blowing all his money away funding you',
];

console.log(`model=${MODEL}\n`);
for (const m of MSGS) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: m }],
        max_tokens: 40,
      }),
    });
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content?.trim() || JSON.stringify(j).slice(0, 120);
    console.log(`${raw.padEnd(48)}  <-  "${m.slice(0, 50)}"`);
  } catch (e) {
    console.log(`ERR ${e.message}  <- "${m.slice(0, 40)}"`);
  }
}

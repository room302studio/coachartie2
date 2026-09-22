/**
 * Measure what a real reply would cost — WITHOUT calling the API.
 *
 * Builds the actual message chain through ContextAlchemy using the real DB prompts and real
 * Discord history, then reports the token breakdown per message and says what the prompt
 * cache would do with it. No model is called, so this costs nothing and can be run with the
 * OpenRouter account at zero.
 *
 * It also renders the chain twice and diffs the cached prefix byte-for-byte, which is the
 * only way to prove no invalidator remains without paying for two live calls.
 *
 * Deps resolve from packages/capabilities (the repo root has no node_modules), so run it
 * from there — paths below are all script-relative, so cwd doesn't otherwise matter:
 *   cd packages/capabilities && node ../../scripts/measure-prompt.mjs [guildId]
 *   cd packages/capabilities && node ../../scripts/measure-prompt.mjs --stability
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// __dirname doesn't exist in ESM; derive it so this works from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

config({ path: resolve(REPO, '.env') });

const SB_GUILD = '1420846272545296470';
const guildId = process.argv.find((a) => /^\d{17,20}$/.test(a)) || SB_GUILD;
const doStability = process.argv.includes('--stability');

const { getSyncDb } = await import('@coachartie/shared');
const { estimateTokens } = await import('@coachartie/shared');
const CAPS = resolve(REPO, 'packages/capabilities/dist/services/llm');
const { contextAlchemy } = await import(`file://${CAPS}/context-alchemy.js`);
const { promptManager } = await import(`file://${CAPS}/prompt-manager.js`);
const { applyCacheControl, cacheMinimumFor } = await import(`file://${CAPS}/prompt-cache.js`);

const db = getSyncDb();

// Real recent channel traffic — the transcript is the block that was never token-capped,
// so measuring it against synthetic messages would miss the entire point.
const rows = db
  .prepare(
    `SELECT value, user_id, created_at FROM messages
     WHERE guild_id = ? AND value IS NOT NULL AND length(trim(value)) > 0
     ORDER BY created_at DESC LIMIT 50`
  )
  .all(guildId);

if (rows.length === 0) {
  console.error(`No messages found for guild ${guildId}`);
  process.exit(1);
}

const discordChannelHistory = rows
  .reverse()
  .map((r) => ({
    author: `User${String(r.user_id).slice(-4)} (@u${String(r.user_id).slice(-4)})`,
    content: String(r.value),
    timestamp: r.created_at,
    isBot: false,
    isSelf: false,
  }));

const avgChars = Math.round(
  discordChannelHistory.reduce((t, m) => t + m.content.length, 0) / discordChannelHistory.length
);

const userMessage = 'hey artie what do you think about the new express tracks';

async function build() {
  const baseSystemPrompt = await promptManager.getCapabilityInstructions(userMessage);
  const { messages } = await contextAlchemy.buildMessageChain(
    userMessage,
    'measurement-harness',
    baseSystemPrompt,
    [],
    {
      source: 'discord',
      discordChannelHistory,
      discordContext: { platform: 'discord', guildId, channelName: 'general' },
    }
  );
  return messages;
}

console.log(`\n=== Measuring guild ${guildId} ===`);
console.log(`${discordChannelHistory.length} real messages, avg ${avgChars} chars\n`);

const messages = await build();

let total = 0;
console.log('  #  role       tokens  preview');
console.log('  -  ---------  ------  ' + '-'.repeat(50));
messages.forEach((m, i) => {
  const tok = estimateTokens(m.content);
  total += tok;
  const preview = m.content.replace(/\s+/g, ' ').slice(0, 50);
  console.log(
    `  ${String(i).padEnd(2)} ${m.role.padEnd(9)} ${String(tok).padStart(6)}  ${preview}`
  );
});

console.log('  ' + '-'.repeat(72));
console.log(`  TOTAL INPUT: ${total} tokens`);

console.log('\n=== Prompt cache ===');
for (const model of [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-4o-mini',
]) {
  const d = applyCacheControl(messages, model);
  const min = model.startsWith('anthropic/') ? ` (min ${cacheMinimumFor(model)})` : '';
  if (d.applied) {
    const pct = Math.round((d.prefixTokens / total) * 100);
    console.log(
      `  ${model.padEnd(30)} CACHED ${d.prefixTokens}tok = ${pct}% of prompt${min}`
    );
  } else {
    console.log(`  ${model.padEnd(30)} not cached — ${d.reason}`);
  }
}

console.log('\n=== Steady-state cost per call (cache warm) ===');
// Opus 4.8 on OpenRouter: $5/M in. A cache read bills at ~0.1x.
const IN_PER_M = 5.0;
const d = applyCacheControl(messages, 'anthropic/claude-opus-4.8');
const cachedTok = d.applied ? d.prefixTokens : 0;
const uncached = total - cachedTok;
const cold = (total / 1e6) * IN_PER_M;
const warm = (uncached / 1e6) * IN_PER_M + (cachedTok / 1e6) * IN_PER_M * 0.1;
console.log(`  uncached (today):  $${cold.toFixed(5)} / call`);
console.log(`  cached (warm):     $${warm.toFixed(5)} / call`);
console.log(`  saving:            ${Math.round((1 - warm / cold) * 100)}% of input cost`);
console.log(`\n  vs Sept measured:  20,109 tokens/call → this build is ${total} (${Math.round((1 - total / 20109) * 100)}% smaller)`);

if (doStability) {
  console.log('\n=== Prefix byte-stability (the invalidator test) ===');
  console.log('  Re-rendering in 61s — the old bug was a per-MINUTE timestamp in the prefix...');
  await new Promise((r) => setTimeout(r, 61_000));
  const again = await build();
  const a = messages[0].content;
  const b = again[0].content;
  if (a === b) {
    console.log(`  ✅ STABLE — system prefix byte-identical across a minute boundary (${a.length} chars)`);
  } else {
    console.log(`  ❌ UNSTABLE — prefix changed; caching will never hit. First difference:`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`     at char ${i}:`);
        console.log(`       run1: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}`);
        console.log(`       run2: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`);
        break;
      }
    }
    process.exitCode = 1;
  }
}

console.log('');
process.exit(process.exitCode ?? 0);

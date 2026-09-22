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
 * Lives under packages/capabilities because ESM resolves bare specifiers (dotenv,
 * @coachartie/shared) relative to the FILE, not the cwd — and the repo root has no
 * node_modules. Run from anywhere:
 *   node packages/capabilities/scripts/measure-prompt.mjs [guildId]
 *   node packages/capabilities/scripts/measure-prompt.mjs --stability
 */

import { config } from 'dotenv';
import { resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

// __dirname doesn't exist in ESM; derive it so this works from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

config({ path: resolve(REPO, '.env') });

// The shared logger mkdir's its log dir at import time and defaults to a relative './logs'
// that only exists on the VPS. Point it somewhere real before importing anything shared,
// or this dies on import with an ENOENT that has nothing to do with the measurement.
process.env.LOGS_DIR = process.env.LOGS_DIR || tmpdir();

// Finding the DB is fiddlier than it should be. The default is './data/coachartie.db',
// relative to cwd; .env on the VPS still carries a stale Docker-era '/app/data/...'; and
// what production actually uses is neither — ecosystem.config.cjs computes an absolute path
// and PM2's env overrides .env. So: trust the configured value only if it exists, and
// otherwise fall back to the real file next to the repo.
const repoDb = resolve(REPO, 'data/coachartie.db');
const configured = process.env.DATABASE_PATH;
if (!configured || !isAbsolute(configured) || !existsSync(configured)) {
  if (configured && !existsSync(configured)) {
    console.warn(`  (ignoring DATABASE_PATH=${configured} — no such file)`);
  }
  process.env.DATABASE_PATH = repoDb;
}
if (!existsSync(process.env.DATABASE_PATH)) {
  console.error(`No database at ${process.env.DATABASE_PATH} — set DATABASE_PATH.`);
  process.exit(1);
}

const SB_GUILD = '1420846272545296470';
const guildId = process.argv.find((a) => /^\d{17,20}$/.test(a)) || SB_GUILD;
const doStability = process.argv.includes('--stability');

const { getSyncDb } = await import('@coachartie/shared');
const { estimateTokens } = await import('@coachartie/shared');
const CAPS = resolve(HERE, '../dist/services/llm');
const { contextAlchemy } = await import(`file://${CAPS}/context-alchemy.js`);
const { promptManager } = await import(`file://${CAPS}/prompt-manager.js`);
const { applyCacheControl, cacheMinimumFor } = await import(`file://${CAPS}/prompt-cache.js`);

// ── Make the harness look like production, or it measures a fiction ────────────────────
// Two omissions here previously understated the prompt by ~8,000 tokens and produced a
// "68% smaller" result that was entirely instrument error.

// 1. The capability registry. Production bootstraps 72 capabilities; an un-bootstrapped
//    import holds 2. The roster is verbatim text inside the system prompt, so without this
//    the measured prefix is less than half its real size.
const { capabilityBootstrap } = await import(
  `file://${resolve(HERE, '../dist/services/capability/capability-bootstrap.js')}`
);
capabilityBootstrap.initializeCapabilityRegistry();

// 2. Guild knowledge. The discord package assembles the persona file + scratchpad + the
//    SB prompt blocks and passes it in as `guildKnowledge`. Without it context-alchemy falls
//    through to loadGuildPrompt, which resolves a stale 1,591-char February copy that
//    shadows the live 8,543-char file — so the persona silently shrank 5x in the measurement.
const { getEnhancedGuildContext } = await import(
  `file://${resolve(REPO, 'packages/discord/dist/handlers/message-handler.js')}`
);
const { getGuildConfig } = await import(
  `file://${resolve(REPO, 'packages/discord/dist/config/guild-whitelist.js')}`
);

const db = getSyncDb();

// Real recent channel traffic — the transcript is the block that was never token-capped,
// so measuring it against synthetic messages would miss the entire point.
// getSyncDb() is a wrapper (get/all/run taking a params array), not raw better-sqlite3.
const rows = db.all(
  `SELECT value, user_id, created_at FROM messages
   WHERE guild_id = ? AND value IS NOT NULL AND length(trim(value)) > 0
   ORDER BY created_at DESC LIMIT 50`,
  [guildId]
);

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

const guildConfig = getGuildConfig(guildId);
const guildKnowledge = getEnhancedGuildContext(guildConfig);
console.log(
  `registry: ${(await import(`file://${resolve(HERE, '../dist/services/capability/capability-registry.js')}`)).capabilityRegistry.list().length} capabilities | ` +
    `guildKnowledge: ${guildKnowledge ? guildKnowledge.length + ' chars' : 'MISSING'}`
);

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
      discordContext: {
        platform: 'discord',
        guildId,
        channelName: 'general',
        guildKnowledge,
      },
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
const totalChars = messages.reduce((t, m) => t + m.content.length, 0);
console.log(`  TOTAL INPUT: ${total} est tokens / ${totalChars} chars`);
// chars/4 is ~49% low on opus-4.8 and sonnet-5, whose real ratio is ~2.7 chars/token
// (measured from context_snapshots joined to API-reported prompt_tokens). Comparing an
// estimate against a billed figure is what made the earlier claim wrong; show both.
console.log(`  BILLED ESTIMATE at 2.7 chars/tok (opus-4.8 / sonnet-5): ~${Math.round(totalChars / 2.7)} tokens`);
console.log(`  Compare against model_usage_stats.input_length (chars), not prompt_tokens.`);

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
// September's real average: 20,109 billed prompt_tokens on 54,980 chars of input_length.
// Compare chars to chars — that is the only apples-to-apples pair available.
const SEPT_CHARS = 54980;
const deltaPct = Math.round((1 - totalChars / SEPT_CHARS) * 100);
console.log(
  `\n  vs Sept real call: ${SEPT_CHARS} chars → this build ${totalChars} chars (${deltaPct >= 0 ? deltaPct + '% smaller' : Math.abs(deltaPct) + '% LARGER'})`
);

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

// One-off: analyze per-user message volume in #prison to calibrate the antibody thresholds.
// Counts, per user, the MAX messages they sent in any 30-minute sliding window (the antibody's
// window). In mention-only #prison, ~1 human message ≈ 1 Artie reply, so this approximates how
// many replies each person would pull in a window. Run on the VPS: node scripts/analyze-antibody.mjs
import { readFileSync } from 'fs';

const env = readFileSync('/data2/apps/coachartie2/.env', 'utf8');
const TOKEN = (env.match(/^DISCORD_TOKEN=(.*)$/m)?.[1] || '').replace(/"/g, '').trim();
const CH = '1520088794551025684';
const WINDOW_MS = 30 * 60 * 1000;

const msgs = [];
let before = '';
for (let i = 0; i < 8; i++) {
  const url = `https://discord.com/api/v10/channels/${CH}/messages?limit=100${before ? `&before=${before}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bot ${TOKEN}` } });
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) break;
  msgs.push(...batch);
  before = batch[batch.length - 1].id;
}

msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
const span = msgs.length ? `${msgs[0].timestamp} -> ${msgs[msgs.length - 1].timestamp}` : 'none';

// Per-user: timestamps of their (human) messages
const byUser = new Map();
for (const m of msgs) {
  if (m.author.bot) continue;
  const u = m.author.username;
  if (!byUser.has(u)) byUser.set(u, []);
  byUser.get(u).push(new Date(m.timestamp).getTime());
}

// Max messages in any 30-min sliding window per user
function maxInWindow(times) {
  times.sort((a, b) => a - b);
  let max = 0, lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= WINDOW_MS) lo++;
    max = Math.max(max, hi - lo + 1);
  }
  return max;
}

const rows = [...byUser.entries()]
  .map(([u, t]) => ({ user: u, total: t.length, maxWin: maxInWindow(t) }))
  .sort((a, b) => b.maxWin - a.maxWin);

console.log(`msgs=${msgs.length}  span=${span}\n`);
console.log('user'.padEnd(22), 'total', 'max/30min');
for (const r of rows) console.log(r.user.padEnd(22), String(r.total).padEnd(5), r.maxWin);

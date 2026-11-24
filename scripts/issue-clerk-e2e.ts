/**
 * Issue-clerk end-to-end check against REAL GitHub, no LLM, no Discord, no prod DB.
 *
 * Drives the same code paths the bot uses (capability registry -> approval gate -> pending
 * queue -> approvals replay -> github tool; poller -> event processor) against the private
 * fixture repo coachartie/issue-clerk-sandbox, and verifies every write with an independent
 * GitHub GET. Re-run it after any change to the github tool, the approval queue, the watcher,
 * or the GITHUB_TOKEN (the fine-grained replacement must include the sandbox repo).
 *
 * Run on the VPS bench, never in the prod checkout (2026-11-13):
 *   cd /data2/tmp/artie-bench
 *   export PATH=$HOME/.nvm/versions/node/v20.19.0/bin:$PATH
 *   export GITHUB_TOKEN=<the GITHUB_TOKEN value from /data2/apps/coachartie2/.env.production,
 *     read by pipe (grep | cut, strip quotes and any inline comment), never typed or printed>
 *   export DATABASE_PATH=/data2/tmp/artie-bench/e2e.db OPENROUTER_API_KEY=dummy NODE_ENV=test
 *   rm -f $DATABASE_PATH && npx tsx scripts/issue-clerk-e2e.ts
 *
 * It creates three issues per run in the sandbox and closes them at the end.
 */
import { Octokit } from '@octokit/rest';
import { capabilityBootstrap } from '../packages/artie/src/engine/capabilities/register-all.js';
import { capabilityRegistry } from '../packages/artie/src/engine/capabilities/registry.js';
import { OWNER_USER_ID } from '../packages/artie/src/shared/config/owner.js';
import { getPendingAction } from '../packages/artie/src/shared/pending-actions.js';
import { getSyncDb, initializeDb } from '../packages/artie/src/shared/db/client.js';
import { ARTIE_WRITE_MARKER } from '../packages/artie/src/engine/capabilities/dev/github.js';
import { GitHubPollerService, type GitHubSyncEvent } from '../packages/artie/src/gateway/watchers/github/poller.js';
import { GitHubEventProcessor } from '../packages/artie/src/gateway/watchers/github/event-batcher.js';
import { resolveSelfLogin } from '../packages/artie/src/gateway/watchers/github/self-identity.js';
import {
  fetchNeedsHumanCounts,
  formatNeedsHumanLine,
} from '../packages/artie/src/gateway/watchers/github/studio-digest.js';

const OWNER = 'coachartie';
const REPO = 'issue-clerk-sandbox';
const FULL = `${OWNER}/${REPO}`;
const NOT_OWNER = 'e2e-requester';
const FOOTER = 'Posted by Coach Artie';
const RUN = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// ---- rails: never become a second Artie, never touch anything but the sandbox ----
if (process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is set; refusing to run (this must not be prod).');
if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set.');
if (!/tmp|bench/.test(process.env.DATABASE_PATH ?? '')) throw new Error('DATABASE_PATH must be a scratch file.');

const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
const results: Array<{ ok: boolean; name: string; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ ok, name, detail });
  let mark = 'FAIL';
  if (ok) mark = 'PASS';
  let suffix = '';
  if (detail) suffix = `  (${detail})`;
  console.log(`${mark}  ${name}${suffix}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** First re-poll after 3s, then every 10s (GitHub's issue list is eventually consistent). */
function pollGap(attempt: number): number {
  if (attempt === 0) return 3000;
  return 10000;
}

function assertSandbox(params: Record<string, unknown>): void {
  if (params.repo !== FULL) throw new Error(`refusing a write outside the sandbox: ${String(params.repo)}`);
}

/** Non-owner asks (parked), then the owner approves; returns the pending id and replay output. */
async function gatedThenApproved(action: string, params: Record<string, unknown>, content?: string) {
  assertSandbox(params);
  const ask = await capabilityRegistry.execute('github', action, params, content, { userId: NOT_OWNER });
  const idMatch = /pending #(\d+)/.exec(ask);
  check(`${action}: parked for approval`, Boolean(idMatch) && ask.includes("needs EJ's approval"), ask.slice(0, 80));
  if (!idMatch) return { id: -1, out: '' };
  const id = Number(idMatch[1]);
  let out = '';
  try {
    out = await capabilityRegistry.execute('approvals', 'approve', { id }, undefined, { userId: OWNER_USER_ID });
  } catch (error) {
    out = `THREW: ${String(error)}`;
  }
  return { id, out };
}

async function issue(n: number) {
  return (await gh.issues.get({ owner: OWNER, repo: REPO, issue_number: n })).data;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function main(): Promise<void> {
  // Same schema bootstrap the test suite uses (test-setup.ts), on the scratch file.
  initializeDb(process.env.DATABASE_PATH!);
  capabilityBootstrap.initializeCapabilityRegistry();
  const self = await resolveSelfLogin(gh as any);
  check('self login resolves live (not the fallback by accident)', self === 'coachartie', self);

  // ---- watcher baseline: silent first sync ----
  const db = getSyncDb();
  db.run(
    `INSERT INTO github_repo_watches (repo, guild_id, channel_id, events, settings, is_active, created_by, created_at, updated_at)
     VALUES (?, 'e2e-guild', 'e2e-channel', '["all"]', '{}', 1, 'e2e', datetime('now'), datetime('now'))`,
    [FULL]
  );
  const watch: any = db.get(`SELECT * FROM github_repo_watches WHERE repo = ?`, [FULL]);
  const poller: any = new GitHubPollerService(process.env.GITHUB_TOKEN!);
  const events: GitHubSyncEvent[] = [];
  poller.on('github-event', (e: GitHubSyncEvent) => events.push(e));
  // drizzle row -> the camelCase shape pollRepo reads
  const watchShape = {
    id: watch.id,
    repo: watch.repo,
    guildId: watch.guild_id,
    channelId: watch.channel_id,
    events: watch.events,
    settings: watch.settings,
    isActive: true,
  };
  await poller.pollRepo(watchShape);
  check('first sync is silent', events.length === 0, `${events.length} events`);

  // ---- create three issues through the gate ----
  const titles = {
    a: `Trains disappear after loading a save [e2e ${RUN}]`,
    b: `Trains disappear when loading save file [e2e ${RUN}]`,
    c: `Add dark mode to settings menu [e2e ${RUN}]`,
  };
  const nums: Record<string, number> = {};
  for (const [key, title] of Object.entries(titles)) {
    let labels = '';
    if (key === 'a') labels = 'e2e';
    const { id, out } = await gatedThenApproved('create_issue', { repo: FULL, title, body: `e2e body ${key}`, labels });
    const m = /"issueNumber":(\d+)/.exec(out);
    check(`create_issue ${key}: approved replay created it`, Boolean(m), out.slice(0, 120));
    check(`create_issue ${key}: pending row marked executed`, getPendingAction(id)?.status === 'executed');
    if (m) nums[key] = Number(m[1]);
  }
  if (!nums.a || !nums.b || !nums.c) throw new Error('could not create the three issues; stopping');

  const a0 = await issue(nums.a);
  check('created issue author is coachartie', a0.user?.login === 'coachartie', a0.user?.login);
  check('provenance footer appears exactly once', countOf(a0.body ?? '', FOOTER) === 1);
  check('provenance marker present', (a0.body ?? '').includes(ARTIE_WRITE_MARKER));
  check('labels on create (csv string) applied', a0.labels.map((l: any) => l.name).join() === 'e2e');

  // ---- watcher pass 1: the three issue_opened events must all be filtered as self ----
  // GitHub's issue list is eventually consistent (a new issue can be missing for a while), so
  // poll like the bot does until all three show, then require each was announced exactly once.
  const created = [nums.a, nums.b, nums.c];
  const openedNums = () => events.filter((e) => e.type === 'issue_opened').map((e) => e.data.issueNumber as number);
  let polls1 = 0;
  while (polls1 < 9 && !created.every((n) => openedNums().includes(n))) {
    await sleep(pollGap(polls1));
    await poller.pollRepo(watchShape);
    polls1 += 1;
  }
  const opened = events.filter((e) => e.type === 'issue_opened');
  check('poller saw the three new issues, each exactly once', opened.length === 3 && created.every((n) => openedNums().filter((x) => x === n).length === 1), `${openedNums().join(',')} after ${polls1} polls`);
  const processor = new GitHubEventProcessor();
  for (const e of opened) {
    const p = await processor.processEvent(e);
    check(`echo filter drops ${e.type} #${e.data.issueNumber}`, !p.shouldPost && p.skipReason === 'Self-generated event', p.skipReason);
  }
  events.length = 0;
  await sleep(2000);

  // ---- dedupe (reordered params), then deny: nothing written ----
  const p1 = await capabilityRegistry.execute('github', 'add_labels', { repo: FULL, issueNumber: String(nums.a), labels: 'dedupe-test' }, undefined, { userId: NOT_OWNER });
  const p2 = await capabilityRegistry.execute('github', 'add_labels', { labels: 'dedupe-test', issueNumber: String(nums.a), repo: FULL }, undefined, { userId: NOT_OWNER });
  const id1 = Number(/pending #(\d+)/.exec(p1)?.[1]);
  const id2 = Number(/pending #(\d+)/.exec(p2)?.[1]);
  check('dedupe: reordered identical ask reuses the same pending id', id1 > 0 && id1 === id2, `${id1} vs ${id2}`);
  const denied = await capabilityRegistry.execute('approvals', 'deny', { id: id1 }, undefined, { userId: OWNER_USER_ID });
  check('deny resolves it', denied.includes('Denied'));
  check('deny wrote nothing to GitHub', !(await issue(nums.a)).labels.some((l: any) => l.name === 'dedupe-test'));

  // ---- TTL: an expired ask can't be approved, nothing written ----
  const t = await capabilityRegistry.execute('github', 'add_comment', { repo: FULL, issueNumber: String(nums.c), body: 'should never post' }, undefined, { userId: NOT_OWNER });
  const tid = Number(/pending #(\d+)/.exec(t)?.[1]);
  db.run(`UPDATE pending_actions SET created_at = datetime('now', '-8 days') WHERE id = ?`, [tid]);
  const late = await capabilityRegistry.execute('approvals', 'approve', { id: tid }, undefined, { userId: OWNER_USER_ID });
  check('TTL: approving an 8-day-old ask is refused', late.includes('expired'), late.slice(0, 80));
  check('TTL: nothing was posted', (await issue(nums.c)).comments === 0);

  // ---- the write primitives ----
  await gatedThenApproved('add_labels', { repo: FULL, issueNumber: String(nums.a), labels: 'bug,P2' });
  let names = (await issue(nums.a)).labels.map((l: any) => l.name).sort();
  check('add_labels is additive (kept e2e, added bug and P2)', names.join() === 'P2,bug,e2e', names.join());

  await gatedThenApproved('remove_label', { repo: FULL, issueNumber: String(nums.a), label: 'P2' });
  names = (await issue(nums.a)).labels.map((l: any) => l.name).sort();
  check('remove_label removes just that one', names.join() === 'bug,e2e', names.join());

  const noop = await gatedThenApproved('remove_label', { repo: FULL, issueNumber: String(nums.a), label: 'never-there' });
  check('remove_label of an absent label is a reported no-op', noop.out.includes('was not on the issue'), noop.out.slice(0, 120));

  const missing = await gatedThenApproved('remove_label', { repo: FULL, issueNumber: '999999', label: 'bug' });
  check('remove_label on a missing issue fails loudly', missing.out.startsWith('THREW') && getPendingAction(missing.id)?.status === 'failed', missing.out.slice(0, 120));

  await gatedThenApproved('add_comment', { repo: FULL, issueNumber: String(nums.b), body: `Possible duplicate of #${nums.a}` });
  const comments = (await gh.issues.listComments({ owner: OWNER, repo: REPO, issue_number: nums.b })).data;
  check('add_comment posted one comment as coachartie', comments.length === 1 && comments[0].user?.login === 'coachartie');
  check('comment carries footer once and marker', countOf(comments[0]?.body ?? '', FOOTER) === 1 && (comments[0]?.body ?? '').includes(ARTIE_WRITE_MARKER));

  await gatedThenApproved('update_issue', { repo: FULL, issueNumber: String(nums.a), assignees: 'coachartie' });
  check('update_issue assignees', (await issue(nums.a)).assignees?.some((u: any) => u.login === 'coachartie') === true);

  const dup = await gatedThenApproved('update_issue', { repo: FULL, issueNumber: String(nums.b), duplicateOf: `#${nums.a}` });
  const b1 = await issue(nums.b);
  check('close as duplicate: closed with state_reason duplicate', b1.state === 'closed' && b1.state_reason === 'duplicate', `${b1.state}/${b1.state_reason} ${dup.out.slice(0, 100)}`);

  await gatedThenApproved('update_issue', { repo: FULL, issueNumber: String(nums.b), state_reason: 'reopened' });
  const b2 = await issue(nums.b);
  check('state_reason reopened alone reopens', b2.state === 'open', `${b2.state}/${b2.state_reason}`);

  await gatedThenApproved('update_issue', { repo: FULL, issueNumber: String(nums.c), state: 'closed', state_reason: 'not_planned' });
  const c1 = await issue(nums.c);
  check('close as not_planned', c1.state === 'closed' && c1.state_reason === 'not_planned', `${c1.state}/${c1.state_reason}`);

  // ---- watcher pass 2: labels, comment, assign, closes by Artie must all be filtered ----
  const want = ['issue_closed', 'issue_comment', 'issue_labeled'];
  let polls2 = 0;
  while (polls2 < 9 && !want.every((k) => events.some((e) => e.type === k))) {
    await sleep(pollGap(polls2));
    await poller.pollRepo(watchShape);
    polls2 += 1;
  }
  const kinds = events.map((e) => e.type);
  check('no issue re-announced as opened in pass 2', !kinds.includes('issue_opened'), kinds.join(','));
  check('poller saw Artie\'s follow-up activity', events.length > 0, kinds.join(','));
  check('poller saw the close', kinds.includes('issue_closed'));
  check('poller saw the comment', kinds.includes('issue_comment'));
  check('poller saw a label change', kinds.includes('issue_labeled'));
  for (const e of events) {
    const p = await processor.processEvent(e);
    check(`echo filter drops ${e.type} #${e.data.issueNumber ?? e.data.prNumber}`, !p.shouldPost && p.skipReason === 'Self-generated event', p.skipReason ?? 'POSTED');
  }
  // control: the same kind of event from a human still posts
  const human = await processor.processEvent({
    type: 'issue_opened',
    repo: FULL,
    channelId: 'e2e-channel',
    guildId: 'e2e-guild',
    data: { issueNumber: 424242, issueTitle: 'human control', issueAuthor: 'ejfox', issueUrl: 'u' },
    timestamp: new Date().toISOString(),
  } as GitHubSyncEvent);
  check('control: a human-opened issue still posts', human.shouldPost === true, human.skipReason);

  // ---- search-backed reads (index lag: retry up to ~3 min, spaced for the rate limit) ----
  // Earlier runs left same-titled issues in the sandbox (titles differ only in the run tag), so
  // this run's twin can tie with or trail an older twin. The check: it is found as a strong
  // match (0.5+), and the dark-mode issue is not. Wide spacing: a tight search burst trips
  // GitHub's secondary limit for minutes.
  let top: any = null;
  let lastSeen = '';
  for (let attempt = 0; attempt < 6 && !top; attempt += 1) {
    await sleep(30000);
    try {
      const raw = await capabilityRegistry.execute('github', 'find_similar_issues', { repo: FULL, title: titles.b, excludeNumber: String(nums.b), limit: '20' }, undefined, { userId: NOT_OWNER });
      const matches: any[] = JSON.parse(raw).data.matches;
      lastSeen = matches.map((m) => `#${m.number}:${m.score}`).join(' ');
      const twin = matches.find((m) => m.number === nums.a);
      const decoy = matches.find((m) => m.number === nums.c);
      if (twin && twin.score >= 0.5 && (!decoy || decoy.score < 0.5)) top = twin;
    } catch (error) {
      console.log(`  (search attempt ${attempt + 1}: ${String(error).slice(0, 80)})`);
    }
  }
  let topDetail = `not found; last matches: ${lastSeen}`;
  if (top) topDetail = `#${top.number} score ${top.score}`;
  check('find_similar_issues finds the real duplicate as a strong match', Boolean(top), topDetail);

  await sleep(5000);
  const triage = JSON.parse(await capabilityRegistry.execute('github', 'list_triage', { repo: FULL, filter: 'unassigned' }, undefined, { userId: NOT_OWNER })).data;
  const openIssues = (await gh.issues.listForRepo({ owner: OWNER, repo: REPO, state: 'open', per_page: 100 })).data.filter((i: any) => !i.pull_request);
  const unassigned = openIssues.filter((i: any) => (i.assignees ?? []).length === 0).length;
  const unlabeled = openIssues.filter((i: any) => i.labels.length === 0).length;
  check('list_triage open count matches an independent listing', triage.counts.open === openIssues.length, `${triage.counts.open} vs ${openIssues.length}`);
  check('list_triage unassigned matches', triage.counts.unassigned === unassigned, `${triage.counts.unassigned} vs ${unassigned}`);
  check('list_triage unlabeled matches', triage.counts.unlabeled === unlabeled, `${triage.counts.unlabeled} vs ${unlabeled}`);

  await sleep(20000);
  const counts = await fetchNeedsHumanCounts(gh as any, OWNER, REPO);
  check('digest counts agree with list_triage', counts?.unassigned === triage.counts.unassigned && counts?.unlabeled === triage.counts.unlabeled, JSON.stringify(counts));
  console.log(`  digest line would read: ${formatNeedsHumanLine(counts) ?? '(none)'}`);

  // ---- tidy the fixture: close this run's open issues directly (not through Artie) ----
  for (const n of Object.values(nums)) {
    await gh.issues.update({ owner: OWNER, repo: REPO, issue_number: n, state: 'closed', state_reason: 'not_planned' });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
  process.exit();
}

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exit(2);
});

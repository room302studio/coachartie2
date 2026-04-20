import * as crypto from 'crypto';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { mediaWikiManager } from '../services/external/mediawiki-manager.js';

interface GitHubWebhookPayload {
  action?: string;
  repository?: {
    name: string;
    full_name: string;
    html_url: string;
  };
  head_commit?: {
    id: string;
    message: string;
    author: {
      name: string;
    };
    url: string;
  };
  release?: {
    tag_name: string;
    name: string;
    body: string;
    html_url: string;
    author: {
      login: string;
    };
    published_at: string;
  };
  pull_request?: {
    number: number;
    title: string;
    user: {
      login: string;
    };
    html_url: string;
    merged: boolean;
    state: string;
    additions?: number;
    deletions?: number;
    base?: {
      ref: string;
    };
  };
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: {
      login: string;
    };
    html_url: string;
    state: string;
    labels: Array<{ name: string }>;
  };
  comment?: {
    id: number;
    body: string;
    user: {
      login: string;
    };
    html_url: string;
  };
  pusher?: {
    name: string;
  };
  ref?: string;
  commits?: Array<{
    id: string;
    message: string;
    author: {
      name: string;
    };
    url: string;
  }>;
  [key: string]: unknown;
}

interface GitHubWebhookHeaders {
  'x-github-event'?: string;
  'x-github-delivery'?: string;
  'x-hub-signature-256'?: string;
  'user-agent'?: string;
}

interface GitHubPushPayload {
  ref: string;
  repository: {
    name: string;
    full_name: string;
    html_url: string;
  };
  pusher: {
    name: string;
    email: string;
  };
  commits: Array<{
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
    url: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
    author: {
      name: string;
    };
    url: string;
  };
}

interface GitHubReleasePayload {
  action: string;
  release: {
    tag_name: string;
    name: string;
    body: string;
    html_url: string;
    author: {
      login: string;
    };
    published_at: string;
    prerelease: boolean;
    draft: boolean;
  };
  repository: {
    name: string;
    full_name: string;
  };
}

// Dedup for webhook events — prevents duplicate posts if webhook fires multiple times
// or if the poller also catches the same event
const recentWebhookEvents = new Map<string, number>(); // eventKey -> timestamp
const WEBHOOK_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
let webhookPostCount = 0;
let webhookRateLimitResetAt = 0;
const WEBHOOK_MAX_POSTS_PER_MINUTE = 5;

function isWebhookDuplicate(key: string): boolean {
  const now = Date.now();
  // Clean old entries
  for (const [k, ts] of recentWebhookEvents) {
    if (now - ts > WEBHOOK_DEDUP_WINDOW_MS) {
      recentWebhookEvents.delete(k);
    }
  }
  if (recentWebhookEvents.has(key)) {
    return true;
  }
  recentWebhookEvents.set(key, now);
  return false;
}

function isWebhookRateLimited(): boolean {
  const now = Date.now();
  if (now > webhookRateLimitResetAt) {
    webhookPostCount = 0;
    webhookRateLimitResetAt = now + WEBHOOK_RATE_LIMIT_WINDOW_MS;
  }
  if (webhookPostCount >= WEBHOOK_MAX_POSTS_PER_MINUTE) {
    return true;
  }
  webhookPostCount++;
  return false;
}

// Wiki update configuration - can be extended via environment variables
const WIKI_UPDATE_CONFIG: Record<string, WikiUpdateRule> = loadWikiUpdateRules();

interface WikiUpdateRule {
  wiki: string; // Which wiki to update
  page: string; // Which page to update
  format?: 'list' | 'table' | 'append'; // How to format the update
}

function loadWikiUpdateRules(): Record<string, WikiUpdateRule> {
  const rules: Record<string, WikiUpdateRule> = {};

  // Load from environment variables like WIKI_UPDATE_SUBWAYBUILDER=transit:Releases:list
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^WIKI_UPDATE_(.+)$/);
    if (match && value) {
      const repoName = match[1].replace(/_/g, '/'); // WIKI_UPDATE_ejfox_SubwayBuilder
      const [wiki, page, format] = value.split(':');
      rules[repoName.toLowerCase()] = {
        wiki,
        page,
        format: (format as any) || 'list',
      };
    }
  }

  // Default rules if none configured
  if (Object.keys(rules).length === 0) {
    // Smart defaults based on repo names
    rules['ejfox/subwaybuilder'] = {
      wiki: 'transit', // Will try 'transit' wiki, fallback to any available
      page: 'Subway_Builder_Releases',
      format: 'list',
    };
  }

  return rules;
}

export async function handleGitHubWebhook(
  payload: GitHubWebhookPayload,
  headers: GitHubWebhookHeaders
): Promise<void> {
  const event = headers['x-github-event'];
  const delivery = headers['x-github-delivery'];

  logger.info(`🐙 Processing GitHub ${event} event`, {
    delivery,
    repo: payload.repository?.full_name,
  });

  // Verify webhook signature if secret is configured
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    const signature = headers['x-hub-signature-256'];
    if (!verifySignature(payload, signature, process.env.GITHUB_WEBHOOK_SECRET)) {
      logger.warn('🚨 GitHub webhook signature verification failed');
      throw new Error('Invalid webhook signature');
    }
  }

  switch (event) {
    case 'push':
      await handlePushEvent(payload as unknown as GitHubPushPayload);
      break;

    case 'release':
      await handleReleaseEvent(payload as unknown as GitHubReleasePayload);
      break;

    case 'pull_request':
      await handlePullRequestEvent(payload);
      break;

    case 'issues':
      await handleIssueEvent(payload);
      break;

    case 'issue_comment':
      await handleIssueCommentEvent(payload);
      break;

    default:
      logger.info(`📝 Unhandled GitHub event: ${event}`);
  }
}

async function handlePushEvent(payload: GitHubPushPayload): Promise<void> {
  const { ref, repository, pusher, commits } = payload;

  // Only celebrate pushes to main/master
  const branch = ref.replace('refs/heads/', '');
  if (!['main', 'master'].includes(branch)) {
    logger.info(`📝 Skipping push to ${branch} (not main branch)`);
    return;
  }

  logger.info(`🚀 Main branch push detected`, {
    repo: repository.full_name,
    pusher: pusher.name,
    commits: commits.length,
  });

  const celebrationMessage = generatePushCelebration(payload);

  await publishMessage('github-bot', celebrationMessage, 'general', 'GitHub Bot', true);
}

async function handleReleaseEvent(payload: GitHubReleasePayload): Promise<void> {
  const { action, release, repository } = payload;

  // Only handle published releases (not drafts)
  if (action !== 'published' || release.draft) {
    logger.info(`📝 Skipping ${action} release (not published)`);
    return;
  }

  logger.info(`🎉 Release published`, {
    repo: repository.full_name,
    tag: release.tag_name,
    author: release.author.login,
  });

  // Queue message for Artie to process - let him decide where to announce based on his memory
  const artieMessage = `A new release was just published for ${repository.full_name}:

Version: ${release.tag_name}
Name: ${release.name || release.tag_name}
Author: ${release.author.login}
${release.prerelease ? 'Type: Pre-release' : ''}

Release Notes:
${release.body || 'No release notes provided'}

URL: ${release.html_url}

Please announce this release in the appropriate Discord channel.`;

  await publishMessage(
    'github-webhook-release',
    artieMessage,
    'general', // Default channel, but Artie can override via capabilities
    'GitHub Webhook',
    false // Don't skip capability extraction
  );

  // Smart wiki updates based on configuration
  await updateWikiForRelease(repository.full_name, release);
}

async function updateWikiForRelease(repoName: string, release: any): Promise<void> {
  try {
    // Check if this repo has a wiki update rule
    const rule = WIKI_UPDATE_CONFIG[repoName.toLowerCase()];

    if (!rule) {
      // No rule configured, try smart detection
      const repoNameLower = repoName.toLowerCase();

      // Smart wiki selection based on repo name
      let wikiName: string | null = null;
      const pageName = `${repoName.split('/')[1]}_Releases`;

      if (repoNameLower.includes('transit') || repoNameLower.includes('subway')) {
        wikiName = 'transit';
      } else if (repoNameLower.includes('personal')) {
        wikiName = 'personal';
      } else {
        // Try to find any wiki that's available
        const availableWikis = mediaWikiManager.getAvailableWikis();
        if (availableWikis.length > 0) {
          wikiName = availableWikis[0].name;
        }
      }

      if (!wikiName) {
        logger.debug(`No wiki available for ${repoName} release`);
        return;
      }

      await updateWikiPage(wikiName, pageName, release, 'list');
    } else {
      // Use configured rule
      await updateWikiPage(rule.wiki, rule.page, release, rule.format || 'list');
    }
  } catch (error) {
    // Silent fail - don't break webhooks for wiki errors
    logger.debug(`Wiki update skipped for ${repoName}:`, error);
  }
}

async function updateWikiPage(
  wikiName: string,
  pageName: string,
  release: any,
  format: 'list' | 'table' | 'append' = 'list'
): Promise<void> {
  const client = await mediaWikiManager.getClient(wikiName);

  if (!client) {
    logger.debug(`Wiki '${wikiName}' not available`);
    return;
  }

  const page = await client.getPage(pageName);
  let content = page?.content || createInitialReleasePage(pageName, release);

  // Format the new release entry based on format preference
  let newEntry: string;

  switch (format) {
    case 'table':
      newEntry = formatReleaseAsTableRow(release);
      content = appendToWikiTable(content, newEntry);
      break;

    case 'append':
      newEntry = `\n\n== ${release.tag_name} ==\n${release.body || 'No release notes provided.'}`;
      content += newEntry;
      break;

    case 'list':
    default: {
      newEntry = `\n* '''${release.tag_name}''' - ${release.name || release.tag_name} (${new Date(release.published_at).toLocaleDateString()}) [${release.html_url} View on GitHub]`;

      // Find the right place to insert (after header, before first entry)
      const headerEnd = content.indexOf('\n\n');
      if (headerEnd > -1) {
        content = content.slice(0, headerEnd + 2) + newEntry + content.slice(headerEnd + 2);
      } else {
        content += newEntry;
      }
      break;
    }
  }

  await client.editPage(pageName, content, `Added ${release.tag_name} release`);

  logger.info(`✅ Updated ${pageName} on ${wikiName} wiki for ${release.tag_name}`);
}

function createInitialReleasePage(pageName: string, _release: any): string {
  const projectName = pageName.replace(/_/g, ' ').replace(' Releases', '');

  return `= ${projectName} Releases =

This page automatically tracks releases from GitHub.

`;
}

function formatReleaseAsTableRow(release: any): string {
  return `|-
| ${release.tag_name} || ${release.name || '-'} || ${new Date(release.published_at).toLocaleDateString()} || [${release.html_url} View]
`;
}

function appendToWikiTable(content: string, newRow: string): string {
  // Find the table end marker |} and insert before it
  const tableEnd = content.lastIndexOf('|}');
  if (tableEnd > -1) {
    return content.slice(0, tableEnd) + newRow + content.slice(tableEnd);
  }

  // No table found, create one
  return (
    content +
    `
{| class="wikitable"
! Version !! Name !! Date !! Link
${newRow}|}
`
  );
}

async function handlePullRequestEvent(payload: GitHubWebhookPayload): Promise<void> {
  const { action, pull_request, repository } = payload;

  if (!pull_request || !repository) {
    logger.warn('Missing pull_request or repository data');
    return;
  }

  // Only celebrate merged PRs to main
  if (action !== 'closed' || !pull_request.merged || pull_request.base?.ref !== 'main') {
    return;
  }

  logger.info(`🔀 PR merged to main`, {
    repo: repository.full_name,
    pr: pull_request.number,
    author: pull_request.user.login,
  });

  const celebrationMessage = generatePRCelebration(payload);

  await publishMessage('github-bot', celebrationMessage, 'general', 'GitHub Bot', true);
}

async function handleIssueEvent(payload: GitHubWebhookPayload): Promise<void> {
  const { action, issue, repository } = payload;

  if (!issue || !repository) {
    logger.warn('Missing issue or repository data');
    return;
  }

  // Handle opened, closed, reopened
  if (!['opened', 'closed', 'reopened'].includes(action || '')) {
    logger.info(`📝 Skipping issue action: ${action}`);
    return;
  }

  // Dedup check
  const dedupeKey = `issue:${action}:${repository.full_name}:${issue.number}`;
  if (isWebhookDuplicate(dedupeKey)) {
    logger.info(`📝 Skipping duplicate issue event: ${dedupeKey}`);
    return;
  }

  // Rate limit check
  if (isWebhookRateLimited()) {
    logger.warn(`⚠️ Webhook rate limited, dropping issue event: ${dedupeKey}`);
    return;
  }

  // Skip bot-created issues
  if (issue.user.login.includes('[bot]') || issue.user.login === 'github-actions') {
    logger.info(`📝 Skipping bot-created issue by ${issue.user.login}`);
    return;
  }

  const emoji = action === 'opened' ? '📋' : action === 'closed' ? '✅' : '🔄';
  const labels = issue.labels?.map((l) => `\`${l.name}\``).join(' ') || '';

  let message = `${emoji} **Issue #${issue.number} ${action}** in **${repository.name}**\n\n`;
  message += `📝 **${issue.title}**\n`;
  message += `👤 By **${issue.user.login}**\n`;
  if (labels) {
    message += `🏷️ ${labels}\n`;
  }
  if (action === 'opened' && issue.body) {
    const truncatedBody = issue.body.length > 300 ? issue.body.slice(0, 300) + '...' : issue.body;
    message += `\n${truncatedBody}\n`;
  }
  message += `🔗 [View issue](${issue.html_url})`;

  logger.info(`📋 Issue #${issue.number} ${action}`, {
    repo: repository.full_name,
    author: issue.user.login,
  });

  // Post to the subwaybuilder-engineering channel
  await publishMessage('github-bot', message, '1480600810743267420', 'GitHub Bot', true);
}

async function handleIssueCommentEvent(payload: GitHubWebhookPayload): Promise<void> {
  const { action, issue, comment, repository } = payload;

  if (!issue || !comment || !repository || action !== 'created') {
    return;
  }

  // Skip bot comments
  if (comment.user.login.includes('[bot]') || comment.user.login === 'github-actions') {
    return;
  }

  // Dedup check
  const dedupeKey = `issue-comment:${repository.full_name}:${comment.id}`;
  if (isWebhookDuplicate(dedupeKey)) {
    logger.info(`📝 Skipping duplicate issue comment: ${dedupeKey}`);
    return;
  }

  // Rate limit check
  if (isWebhookRateLimited()) {
    logger.warn(`⚠️ Webhook rate limited, dropping issue comment event`);
    return;
  }

  const truncatedBody = comment.body.length > 400 ? comment.body.slice(0, 400) + '...' : comment.body;

  let message = `💬 **${comment.user.login}** commented on issue #${issue.number} in **${repository.name}**\n\n`;
  message += `> ${truncatedBody}\n\n`;
  message += `🔗 [View comment](${comment.html_url})`;

  logger.info(`💬 Issue comment on #${issue.number}`, {
    repo: repository.full_name,
    author: comment.user.login,
  });

  await publishMessage('github-bot', message, '1480600810743267420', 'GitHub Bot', true);
}

function generatePushCelebration(payload: GitHubPushPayload): string {
  const { repository, pusher, commits, head_commit } = payload;
  const commitCount = commits.length;

  const emojis = ['🚀', '✨', '🔥', '⚡', '🎯'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];

  let message = `${emoji} **${pusher.name}** just pushed ${commitCount} commit${commitCount > 1 ? 's' : ''} to **${repository.name}**!\n\n`;

  if (head_commit) {
    message += `📝 Latest: "${head_commit.message}"\n`;
    message += `🔗 [View commit](${head_commit.url})\n\n`;
  }

  // Add some context about what changed
  const totalChanges = commits.reduce(
    (acc, commit) => acc + commit.added.length + commit.modified.length + commit.removed.length,
    0
  );

  if (totalChanges > 0) {
    message += `📊 ${totalChanges} file${totalChanges > 1 ? 's' : ''} changed across ${commitCount} commit${commitCount > 1 ? 's' : ''}`;
  }

  return message;
}

function generatePRCelebration(payload: GitHubWebhookPayload): string {
  const { pull_request, repository } = payload;

  if (!pull_request || !repository) {
    throw new Error('Invalid payload: missing pull_request or repository');
  }

  const emojis = ['🔀', '✅', '🎯', '💪', '🏆'];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];

  let message = `${emoji} **${pull_request.user.login}** merged PR #${pull_request.number} into **${repository.name}**!\n\n`;
  message += `📝 "${pull_request.title}"\n`;
  message += `🔗 [View PR](${pull_request.html_url})\n\n`;

  if (pull_request.additions || pull_request.deletions) {
    message += `📊 +${pull_request.additions || 0} -${pull_request.deletions || 0} lines`;
  }

  return message;
}

function verifySignature(
  payload: GitHubWebhookPayload,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

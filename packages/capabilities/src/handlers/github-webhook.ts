import crypto from 'crypto';
import { logger } from '@coachartie/shared';

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
import { publishMessage } from '../queues/publisher.js';

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

export async function handleGitHubWebhook(payload: GitHubWebhookPayload, headers: GitHubWebhookHeaders): Promise<void> {
  const event = headers['x-github-event'];
  const delivery = headers['x-github-delivery'];

  logger.info(`🐙 Processing GitHub ${event} event`, { delivery, repo: payload.repository?.full_name });

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
    commits: commits.length 
  });

  const celebrationMessage = generatePushCelebration(payload);
  
  await publishMessage(
    'github-bot',
    celebrationMessage,
    'general',
    'GitHub Bot',
    true
  );
}

async function handleReleaseEvent(payload: GitHubReleasePayload): Promise<void> {
  const { action, release, repository } = payload;
  
  // Only celebrate published releases (not drafts)
  if (action !== 'published' || release.draft) {
    logger.info(`📝 Skipping ${action} release (not published)`);
    return;
  }

  logger.info(`🎉 Release published`, { 
    repo: repository.full_name, 
    tag: release.tag_name,
    author: release.author.login 
  });

  const celebrationMessage = generateReleaseCelebration(payload);
  
  await publishMessage(
    'github-bot',
    celebrationMessage,
    'general',
    'GitHub Bot',
    true
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
    author: pull_request.user.login 
  });

  const celebrationMessage = generatePRCelebration(payload);
  
  await publishMessage(
    'github-bot',
    celebrationMessage,
    'general',
    'GitHub Bot',
    true
  );
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
  const totalChanges = commits.reduce((acc, commit) => 
    acc + commit.added.length + commit.modified.length + commit.removed.length, 0);
  
  if (totalChanges > 0) {
    message += `📊 ${totalChanges} file${totalChanges > 1 ? 's' : ''} changed across ${commitCount} commit${commitCount > 1 ? 's' : ''}`;
  }
  
  return message;
}

function generateReleaseCelebration(payload: GitHubReleasePayload): string {
  const { release, repository } = payload;
  
  const isPrerelease = release.prerelease;
  const emoji = isPrerelease ? '🧪' : '🎉';
  const releaseType = isPrerelease ? 'pre-release' : 'release';
  
  let message = `${emoji} **New ${releaseType}**: ${release.name || release.tag_name} is live!\n\n`;
  message += `📦 **${repository.name}** ${release.tag_name}\n`;
  message += `👤 Released by **${release.author.login}**\n`;
  message += `🔗 [View release](${release.html_url})\n\n`;
  
  if (release.body && release.body.length < 300) {
    message += `📝 **What's new:**\n${release.body.substring(0, 300)}${release.body.length > 300 ? '...' : ''}`;
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

function verifySignature(payload: GitHubWebhookPayload, signature: string | undefined, secret: string): boolean {
  if (!signature) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}
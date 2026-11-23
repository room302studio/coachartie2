import type { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { isOwner } from '../../../shared/config/owner.js';
import { mintTrustedGuild, type TrustedGuildId } from '../../../shared/trusted-ids.js';
import { isBlockedUser } from '../../../shared/blocklist.js';
import { isOptedOut } from '../../../shared/privacy-opt-out.js';

/**
 * Discord Forums Capability - Traverse and analyze Discord forum discussions
 *
 * Allows the AI to discover forum channels, read threads, get forum summaries,
 * and sync discussions to GitHub issues.
 *
 * NOTE: This capability requires the Discord service to be running and initialized.
 * It accesses Discord services directly through import rather than HTTP.
 */

interface DiscordForumsParams {
  action: 'list-forums' | 'list-threads' | 'get-thread' | 'get-forum-summary' | 'sync-to-github';
  guildId?: string;
  forumId?: string;
  threadId?: string;
  repo?: string; // For sync-to-github: owner/repo format or URL
  /** Forums/channels the conversation's audience can read; undefined = no filter (EJ's DM). */
  visibleIds?: Set<string>;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** Forums the audience may see: all of them when there's no filter (EJ's DM). */
function visibleForums(forums: any[], visibleIds: Set<string> | undefined): any[] {
  if (!visibleIds) {
    return forums;
  }
  return forums.filter((f: any) => visibleIds.has(String(f?.id)));
}

/** Thread messages minus opted-out and banned authors (same rule as search). */
function withoutHiddenAuthors(messages: any[]): any[] {
  return messages.filter((m: any) => {
    const id = String(m?.author?.id || '');
    return !isBlockedUser(id) && !isOptedOut(id);
  });
}

const FETCH_TIMEOUT = 30000; // 30 second timeout

/**
 * Helper functions for template string formatting
 */
function formatTagsList(tags: any[]): string {
  if (tags.length > 0) {
    if (tags[0].name) {
      return tags.map((t: any) => t.name).join(', ');
    }
    return tags.join(', ');
  }
  return 'None';
}

function formatStatusEmoji(locked: boolean, archived: boolean): string {
  if (locked) {
    return '🔒 Locked';
  }
  if (archived) {
    return '📦 Archived';
  }
  return '✅ Active';
}

function formatTruncated(text: string, limit: number): string {
  if (text.length >= limit) {
    return text + '...';
  }
  return text;
}

function formatEditedTimestamp(timestamp: string | undefined): string | null {
  if (timestamp != null) {
    return new Date(timestamp).toISOString();
  }
  return null;
}

function formatBooleanYesNo(value: boolean): string {
  if (value) {
    return 'Yes';
  }
  return 'No';
}

function calculateAverageMessageLength(messages: any[]): number {
  if (messages.length === 0) {
    return 0;
  }
  const totalLength = messages.reduce((sum: number, m: any) => sum + m.content.length, 0);
  return Math.round(totalLength / messages.length);
}

function formatBotIndicator(isBot: boolean): string {
  if (isBot) {
    return ' 🤖';
  }
  return '';
}

function formatEditedInfo(edited: string | null): string {
  if (edited) {
    return ` (Edited: ${new Date(edited).toLocaleString()})`;
  }
  return '';
}

function formatReactions(reactions: any[]): string {
  if (reactions.length === 0) {
    return '';
  }
  return `Reactions: ${reactions.map((r: any) => `${r.emoji} (${r.count})`).join(', ')}`;
}

function countedNextStepLine(count: number, message: string): string {
  if (count > 0) {
    return message;
  }
  return '';
}

function formatAttachments(attachments: any[]): string {
  if (attachments.length === 0) {
    return '';
  }
  return `Attachments: ${attachments.map((a: any) => a.filename).join(', ')}`;
}

function formatMentions(mentions: any[]): string {
  if (mentions.length === 0) {
    return '';
  }
  return `Mentions: ${mentions.join(', ')}`;
}

function formatStatusName(locked: boolean, archived: boolean): string {
  if (locked) {
    return 'locked';
  }
  if (archived) {
    return 'archived';
  }
  return 'active';
}

/**
 * The gateway's forum routes, in-process since wave 9 (were GETs/POSTs to :47321/api/... and
 * :47319/health). Keeps the old request timeout and its error text; `route` is the path the
 * HTTP call used, for that message.
 */
async function callWithTimeout(
  route: string,
  call: Promise<gateway.ApiResult>,
  timeout = FETCH_TIMEOUT
): Promise<gateway.ApiResult> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Request to ${route} timed out after ${timeout}ms`)),
          timeout
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

const handler = async (
  params: any,
  content?: string,
  context?: CapabilityContext
): Promise<string> => {
  // Normalize parameters: accept both snake_case and camelCase from LLM.
  const forumId = params.forumId || params.forum_id;
  const threadId = params.threadId || params.thread_id;
  const action = params.action;

  // Scope (2026-11-23, same rule as discord-search): the server is the conversation's, never one
  // the model names, and every forum or thread must be readable by everyone in the conversation.
  // Before this a model-written guildId reached any server Artie is in, and get-thread read any
  // thread id at all. Only EJ, in a DM, may name a server (he is the whole audience there).
  const ownerDm = !context?.guildId && isOwner(String(context?.userId || ''));
  let guildId: TrustedGuildId | undefined = context?.guildId;
  if (ownerDm) {
    guildId = mintTrustedGuild(params.guildId || params.guild_id, 'owner-dm-choice');
  }
  if (!guildId && !ownerDm) {
    return 'Discord forums only work in a server conversation: they cover the server you are talking in.';
  }
  let visibleIds: Set<string> | undefined;
  if (!ownerDm && guildId) {
    // Every id the call carries is checked on its own: an action may fetch either (Codex).
    const scope = await gateway.audienceReadable(guildId, context?.userId ?? null, context?.channelId);
    for (const [kind, id] of [
      ['forum', forumId],
      ['thread', threadId],
    ] as const) {
      if (!id) {
        continue;
      }
      const check = await gateway.audienceReadable(
        guildId,
        context?.userId ?? null,
        context?.channelId,
        String(id)
      );
      if (!check.ok) {
        return `That ${kind} isn't one everyone in this conversation can read (or isn't in this server), so I won't open it here.`;
      }
    }
    visibleIds = scope.allowed;
  }

  logger.info(`🔍 Discord-forums handler: Raw params: ${JSON.stringify(params)}`);
  logger.info(
    `🔍 Discord-forums handler: Normalized guildId="${guildId}", forumId="${forumId}", threadId="${threadId}", action="${action}"`
  );

  // Rebuild normalized params object
  const normalizedParams: DiscordForumsParams = {
    action,
    guildId,
    forumId,
    threadId,
    repo: params.repo,
    visibleIds,
  };

  logger.info(`🔍 Discord-forums handler: normalizedParams: ${JSON.stringify(normalizedParams)}`);

  try {
    switch (action) {
      case 'list-forums':
        return await listForums(normalizedParams);

      case 'list-threads':
        return await listThreads(normalizedParams);

      case 'get-thread':
        return await getThread(normalizedParams);

      case 'get-forum-summary':
        return await getForumSummary(normalizedParams);

      case 'sync-to-github':
        return await syncToGitHub(normalizedParams, content);

      case 'create-post': {
        // guildId here is the conversation's (or EJ's DM pick); the Room 302 rule is in the gateway.
        const resp = await gateway.createForumPost(guildId ?? null, {
          forumId: String(forumId ?? ''),
          title: String(params.title ?? ''),
          message: String(params.message ?? ''),
          tag: stringOrUndefined(params.tag),
        });
        return JSON.stringify(resp.body);
      }

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    logger.error('Discord forums capability error:', {
      action,
      error: errorMsg,
      params,
      content,
    });
    throw new Error(`Failed to execute Discord forums action: ${errorMsg}`);
  }
};

async function listForums(params: DiscordForumsParams): Promise<string> {
  const { guildId } = params;

  if (!guildId) {
    // Fetch available guilds from health endpoint to provide helpful error
    try {
      const healthResponse = await callWithTimeout('/health', gateway.gatewayHealth());
      if (gateway.isOk(healthResponse)) {
        const health = healthResponse.body as any;
        if (health.discord?.guildDetails && health.discord.guildDetails.length > 0) {
          const guildList = health.discord.guildDetails
            .map((g: any) => `- ${g.name} (ID: ${g.id})`)
            .join('\n');
          throw new Error(
            `No guildId provided. Available Discord servers:\n${guildList}\n\nExample: <capability name="discord-forums" action="list-forums" data='{"guildId":"${health.discord.guildDetails[0].id}"}' />`
          );
        }
      }
    } catch (error) {
      // If we can't fetch guilds, fall back to generic error
      if (error instanceof Error && error.message.includes('Available Discord servers')) {
        throw error; // Re-throw our helpful error
      }
    }
    throw new Error('guildId is required for list-forums action');
  }

  // Call Discord service endpoint to list forums
  const response = await callWithTimeout(
    `/api/guilds/${guildId}/forums`,
    gateway.listGuildForums(String(guildId))
  );

  if (!gateway.isOk(response)) {
    throw new Error(`Failed to fetch forums: ${gateway.statusText(response)}`);
  }

  const data = response.body as any;
  const forums = visibleForums(data.forums || data, params.visibleIds);

  logger.info(`📋 Listed ${forums.length} forums in guild ${guildId}`);

  // Build rich, verbose response with actionable data
  const forumSummaries = forums.map((f: any) => {
    return {
      id: f.id,
      name: f.name,
      type: f.type || 'GUILD_FORUM',
      threadCount: f.threadCount || f.available_tags?.length || 0,
      description: f.topic || 'No description',
      tags: f.availableTags || f.available_tags || [],
      // Provide exact next-call syntax
      nextActions: {
        listThreads: `<capability name="discord-forums" action="list-threads" data='{"forumId":"${f.id}"}' />`,
        getSummary: `<capability name="discord-forums" action="get-forum-summary" data='{"forumId":"${f.id}"}' />`,
        syncToGithub: `<capability name="discord-forums" action="sync-to-github" data='{"forumId":"${f.id}","repo":"owner/repo"}' />`,
      },
    };
  });

  const response_text = `🎯 DISCORD FORUMS DISCOVERY COMPLETE

📊 Summary:
- Guild ID: ${guildId}
- Total Forums: ${forums.length}
- Forum Types: ${[...new Set(forums.map((f: any) => f.type || 'GUILD_FORUM'))].join(', ')}

📋 Available Forums:
${forumSummaries
  .map(
    (f: any, i: number) => `
${i + 1}. ${f.name}
   ID: ${f.id}
   Description: ${f.description}
   Threads: ${f.threadCount}
   Tags: ${formatTagsList(f.tags)}

   Next Actions:
   - List threads: ${f.nextActions.listThreads}
   - Get summary: ${f.nextActions.getSummary}
   - Sync to GitHub: ${f.nextActions.syncToGithub}
`
  )
  .join('\n')}

💡 Recommended Next Steps:
1. To see all discussions in a specific forum:
   ${forumSummaries[0]?.nextActions.listThreads || 'N/A'}

2. To get analytics for a forum:
   ${forumSummaries[0]?.nextActions.getSummary || 'N/A'}

📦 Raw Data (for programmatic access):
${JSON.stringify(forumSummaries, null, 2)}`;

  return response_text;
}

async function listThreads(params: DiscordForumsParams): Promise<string> {
  const { forumId, guildId } = params;

  if (!forumId) {
    // Provide helpful guidance
    const helpMessage =
      `No forumId provided. To list threads, you first need to get a forum ID.\n\n` +
      `Step 1: List forums in a guild using:\n` +
      `<capability name="discord-forums" action="list-forums" data='{"guildId":"YOUR_GUILD_ID"}' />\n\n` +
      `Step 2: Use the returned forum ID to list threads:\n` +
      `<capability name="discord-forums" action="list-threads" data='{"forumId":"FORUM_ID_FROM_STEP_1"}' />`;

    // If guildId was provided, try to help by listing forums
    if (guildId) {
      try {
        const forumsResponse = await callWithTimeout(
          `/api/guilds/${guildId}/forums`,
          gateway.listGuildForums(String(guildId))
        );
        if (gateway.isOk(forumsResponse)) {
          const forumsData = forumsResponse.body as any;
          const shown = visibleForums(forumsData.forums || [], params.visibleIds);
          if (shown.length > 0) {
            const forumList = shown
              .map((f: any) => `- ${f.name} (ID: ${f.id})`)
              .join('\n');
            throw new Error(
              `No forumId provided. Available forums in guild ${guildId}:\n${forumList}\n\nExample: <capability name="discord-forums" action="list-threads" data='{"forumId":"${forumsData.forums[0].id}"}' />`
            );
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Available forums')) {
          throw error; // Re-throw our helpful error
        }
      }
    }

    throw new Error(helpMessage);
  }

  const response = await callWithTimeout(
    `/api/forums/${forumId}/threads`,
    gateway.listForumThreads(String(forumId))
  );

  if (!gateway.isOk(response)) {
    throw new Error(`Failed to fetch threads: ${gateway.statusText(response)}`);
  }

  const data = response.body as any;
  // Posts by opted-out or banned people are left out, title and preview included.
  const threads = (data.threads || data).filter((t: any) => {
    const id = String(t?.owner?.id || t?.author?.id || t?.ownerId || '');
    return !isBlockedUser(id) && !isOptedOut(id);
  });

  logger.info(`📝 Listed ${threads.length} threads in forum ${forumId}`);

  // Build rich thread summaries with preview data
  const threadSummaries = threads.slice(0, 50).map((t: any) => {
    const preview = t.firstMessage?.content?.substring(0, 200) || 'No preview available';
    const author = t.owner || t.author || { username: 'Unknown', id: 'unknown' };

    return {
      id: t.id,
      title: t.name || 'Untitled Thread',
      author: {
        username: author.username || author.user?.username || 'Unknown',
        id: author.id || author.user?.id || 'unknown',
      },
      messageCount: t.message_count || t.messageCount || 0,
      created: t.created_timestamp || t.createdAt || new Date().toISOString(),
      lastActivity: t.last_message_timestamp || t.lastMessageAt || t.created_timestamp,
      tags: t.applied_tags || t.appliedTags || [],
      locked: t.locked || false,
      archived: t.archived || false,
      preview: preview,
      // Provide exact next-call syntax
      nextActions: {
        getFullThread: `<capability name="discord-forums" action="get-thread" data='{"threadId":"${t.id}"}' />`,
        syncToGithub: `<capability name="discord-forums" action="sync-to-github" data='{"forumId":"${forumId}","repo":"owner/repo"}' />`,
      },
    };
  });

  // Calculate summary statistics
  const totalMessages = threadSummaries.reduce((sum: number, t: any) => sum + t.messageCount, 0);
  const activeThreads = threadSummaries.filter((t: any) => !t.archived && !t.locked).length;
  const archivedThreads = threadSummaries.filter((t: any) => t.archived).length;

  const response_text = `🧵 DISCORD THREADS RETRIEVED

📊 Forum Statistics:
- Forum ID: ${forumId}
- Total Threads: ${threads.length}
- Showing: ${threadSummaries.length} threads (limited to 50 for performance)
- Active Threads: ${activeThreads}
- Archived: ${archivedThreads}
- Total Messages: ${totalMessages}

📝 Thread List (sorted by activity):
${threadSummaries
  .map(
    (t: any, i: number) => `
${i + 1}. ${t.title}
   Thread ID: ${t.id}
   Author: ${t.author.username} (${t.author.id})
   Messages: ${t.messageCount}
   Status: ${formatStatusEmoji(t.locked, t.archived)}
   Created: ${new Date(t.created).toLocaleDateString()}
   Last Activity: ${new Date(t.lastActivity).toLocaleDateString()}
   Tags: ${formatTagsList(t.tags)}

   Preview: ${formatTruncated(t.preview, 200)}

   Next Actions:
   - View full thread: ${t.nextActions.getFullThread}
`
  )
  .join('\n')}

💡 Recommended Next Steps:
1. To read a specific thread in detail:
   ${threadSummaries[0]?.nextActions.getFullThread || 'N/A'}

2. To sync all threads to GitHub:
   ${threadSummaries[0]?.nextActions.syncToGithub || 'N/A'}

📦 Raw Data (for programmatic access):
${JSON.stringify(threadSummaries, null, 2)}`;

  return response_text;
}

async function getThread(params: DiscordForumsParams): Promise<string> {
  const { threadId } = params;

  if (!threadId) {
    throw new Error(
      'threadId is required for get-thread action. Example: <capability name="discord-forums" action="get-thread" data=\'{"threadId":"987654321"}\' />\n\nFirst, use list-threads to get available thread IDs.'
    );
  }

  const response = await callWithTimeout(
    `/api/threads/${threadId}`,
    gateway.getForumThread(String(threadId))
  );

  if (!gateway.isOk(response)) {
    throw new Error(`Failed to fetch thread ${threadId}: ${gateway.statusText(response)}`);
  }

  const thread = response.body as any;

  logger.info(
    `💬 Fetched thread ${threadId} with ${thread.messageCount || thread.messages?.length || 0} messages`
  );

  // Extract messages with rich context
  const messages = withoutHiddenAuthors(thread.messages || []).map((m: any, i: number) => ({
    position: i + 1,
    id: m.id,
    author: {
      username: m.author?.username || 'Unknown',
      id: m.author?.id || 'unknown',
      bot: m.author?.bot || false,
    },
    content: m.content || '',
    timestamp: m.timestamp || m.created_timestamp || new Date().toISOString(),
    edited: formatEditedTimestamp(m.edited_timestamp),
    attachments: (m.attachments || []).map((a: any) => ({
      filename: a.filename,
      url: a.url,
      contentType: a.content_type,
      size: a.size,
    })),
    reactions: (m.reactions || []).map((r: any) => ({
      emoji: r.emoji?.name || r.emoji,
      count: r.count || 0,
    })),
    mentions: (m.mentions || []).map((u: any) => u.username || u.id),
  }));

  // Calculate thread analytics
  const uniqueAuthors = new Set(messages.map((m: any) => m.author.id)).size;
  const totalReactions = messages.reduce(
    (sum: number, m: any) => sum + m.reactions.reduce((rSum: number, r: any) => rSum + r.count, 0),
    0
  );
  const hasAttachments = messages.some((m: any) => m.attachments.length > 0);

  const response_text = `💬 THREAD DETAILS RETRIEVED

📋 Thread Information:
- Thread ID: ${(thread as any).id || threadId}
- Title: ${(thread as any).name || (thread as any).title || 'Untitled'}
- Forum ID: ${(thread as any).parent_id || (thread as any).parentId || 'Unknown'}
- Created: ${new Date((thread as any).created_timestamp || (thread as any).createdAt || Date.now()).toLocaleString()}
- Status: ${formatStatusEmoji((thread as any).locked, (thread as any).archived)}
- Tags: ${((thread as any).applied_tags || (thread as any).appliedTags || []).join(', ') || 'None'}

📊 Thread Analytics:
- Total Messages: ${messages.length}
- Unique Participants: ${uniqueAuthors}
- Total Reactions: ${totalReactions}
- Has Attachments: ${formatBooleanYesNo(hasAttachments)}
- Average Message Length: ${calculateAverageMessageLength(messages)} chars

💬 Message Timeline:
${messages
  .map(
    (m: any) => `
Message #${m.position} by ${m.author.username} (${m.author.id})${formatBotIndicator(m.author.bot)}
Posted: ${new Date(m.timestamp).toLocaleString()}${formatEditedInfo(m.edited)}
${formatReactions(m.reactions)}
${formatAttachments(m.attachments)}
${formatMentions(m.mentions)}

Content:
${m.content || '(No text content)'}

${'-'.repeat(80)}
`
  )
  .join('\n')}

💡 This thread is ready for analysis or GitHub sync.
To sync this thread to GitHub:
<capability name="discord-forums" action="sync-to-github" data='{"forumId":"${(thread as any).parent_id || 'FORUM_ID'}","repo":"owner/repo"}' />

📦 Raw Data (for programmatic access):
${JSON.stringify({ thread: { id: (thread as any).id, name: (thread as any).name, status: formatStatusName((thread as any).locked, (thread as any).archived) }, messages }, null, 2)}`;

  return response_text;
}

async function getForumSummary(params: DiscordForumsParams): Promise<string> {
  const { forumId } = params;

  if (!forumId) {
    throw new Error(
      'forumId is required for get-forum-summary action. Example: <capability name="discord-forums" action="get-forum-summary" data=\'{"forumId":"123456789"}\' />\n\nFirst, use list-forums to get available forum IDs.'
    );
  }

  const response = await callWithTimeout(
    `/api/forums/${forumId}/summary`,
    gateway.getForumSummary(String(forumId))
  );

  if (!gateway.isOk(response)) {
    throw new Error(`Failed to fetch forum summary for ${forumId}: ${gateway.statusText(response)}`);
  }

  const summary = response.body as any;

  logger.info(`📊 Fetched summary for forum ${forumId}: ${summary.totalThreads} threads`);

  return `Forum Summary:\n${JSON.stringify(summary, null, 2)}`;
}

async function syncToGitHub(params: DiscordForumsParams, _content?: string): Promise<string> {
  const { forumId, repo } = params;

  if (!forumId) {
    throw new Error('forumId is required for sync-to-github action');
  }

  if (!repo) {
    throw new Error('repo is required for sync-to-github action (format: owner/repo or URL)');
  }

  // Call Discord service to trigger GitHub sync
  const response = await callWithTimeout(
    `/api/forums/${forumId}/sync-to-github`,
    gateway.syncForumToGitHub(String(forumId), { repo }),
    60000
  ); // 60 second timeout for GitHub sync (can be slow)

  if (!gateway.isOk(response)) {
    throw new Error(`Failed to sync to GitHub: ${gateway.statusText(response)}`);
  }

  const result = response.body as any;

  logger.info(
    `🔄 Synced forum ${forumId} to GitHub repo ${repo}: ${result.successCount || result.issues?.length || 0} issues created`
  );

  // Extract detailed results
  const issues = result.issues || [];
  const successCount = result.successCount || issues.filter((i: any) => i.success).length;
  const failureCount = result.failureCount || issues.filter((i: any) => !i.success).length;
  const skippedCount = result.skippedCount || 0;

  // Compute conditional sections
  let successSection: string;
  if (successCount > 0) {
    successSection = `
✅ Successfully Created Issues:
${issues
  .filter((i: any) => i.success)
  .map(
    (issue: any, idx: number) => `
${idx + 1}. ${issue.title || issue.threadTitle || 'Untitled'}
   Issue URL: ${issue.url || issue.issueUrl || 'N/A'}
   Issue Number: #${issue.number || issue.issueNumber || 'N/A'}
   Thread ID: ${issue.threadId || 'N/A'}
   Labels: ${issue.labels?.join(', ') || 'None'}
   State: ${issue.state || 'open'}
`
  )
  .join('\n')}
`;
  } else {
    successSection = '';
  }

  let failureSection: string;
  if (failureCount > 0) {
    failureSection = `
❌ Failed Issues:
${issues
  .filter((i: any) => !i.success)
  .map(
    (issue: any, idx: number) => `
${idx + 1}. ${issue.title || issue.threadTitle || 'Untitled'}
   Thread ID: ${issue.threadId || 'N/A'}
   Error: ${issue.error || 'Unknown error'}
`
  )
  .join('\n')}
`;
  } else {
    failureSection = '';
  }

  let rateLimitSection: string;
  if ((result as any).rateLimitInfo) {
    rateLimitSection = `
⚠️  Rate Limit Information:
- Remaining: ${(result as any).rateLimitInfo.remaining}
- Limit: ${(result as any).rateLimitInfo.limit}
- Reset Time: ${new Date((result as any).rateLimitInfo.reset * 1000).toLocaleString()}
`;
  } else {
    rateLimitSection = '';
  }

  const nextStepsLine1 = countedNextStepLine(successCount, `- View created issues at: https://github.com/${repo}/issues`);
  const nextStepsLine2 = countedNextStepLine(failureCount, `- Review and retry failed syncs`);
  const nextStepsLine3 = countedNextStepLine(skippedCount, `- ${skippedCount} threads were skipped (likely already synced)`);

  const response_text = `🔄 GITHUB SYNC COMPLETE

📊 Sync Summary:
- Forum ID: ${forumId}
- Target Repository: ${repo}
- Total Threads Processed: ${issues.length}
- ✅ Successfully Created: ${successCount}
- ❌ Failed: ${failureCount}
- ⏭️  Skipped (duplicates): ${skippedCount}
- Sync Duration: ${(result as any).duration || 'N/A'}

${successSection}
${failureSection}
${rateLimitSection}

💡 Next Steps:
${nextStepsLine1}
${nextStepsLine2}
${nextStepsLine3}

📦 Raw Data (for programmatic access):
${JSON.stringify(
  {
    summary: {
      forumId,
      repo,
      successCount,
      failureCount,
      skippedCount,
      totalProcessed: issues.length,
    },
    issues: issues.map((i: any) => ({
      threadId: i.threadId,
      issueNumber: i.number || i.issueNumber,
      issueUrl: i.url || i.issueUrl,
      title: i.title || i.threadTitle,
      success: i.success,
      error: i.error,
    })),
  },
  null,
  2
)}`;

  return response_text;
}

const FORUM_ID = {
  type: 'string',
  description: 'Forum channel id (from list-forums)',
  aliases: ['forum_id'],
} as const;

export const discordForumsCapability: RegisteredCapability = {
  name: 'discord-forums',
  // Typed params replace the old data='{json}' blob, which the native tool loop passed through
  // as one unparsed string, so every id arrived undefined (2026-11-17).
  actions: {
    'list-forums': { effect: 'read' }, // the conversation's guild
    'list-threads': { effect: 'read', params: { forumId: { ...FORUM_ID, required: true } } },
    'get-thread': {
      effect: 'read',
      params: {
        threadId: {
          type: 'string',
          description: 'Forum thread id',
          required: true,
          aliases: ['thread_id'],
        },
      },
    },
    'get-forum-summary': { effect: 'read', params: { forumId: { ...FORUM_ID, required: true } } },
    // Creates GitHub issues through the gateway: outside Discord, so it needs EJ's approval
    // (it skipped the gate before declarations existed).
    'sync-to-github': {
      effect: 'outside',
      params: {
        forumId: { ...FORUM_ID, required: true },
        repo: { type: 'string', description: 'GitHub repo, owner/repo', required: true },
      },
    },
    // Starts a post in a Room 302 forum (gateway/routes/discord-write.ts); never pings anyone.
    'create-post': {
      effect: 'discord',
      params: {
        forumId: { ...FORUM_ID, required: true },
        title: { type: 'string', description: 'Post title (max 100 chars)', required: true },
        message: { type: 'string', description: 'The first message of the post', required: true },
        tag: { type: 'string', description: 'A forum tag by name (required by some forums)' },
      },
    },
  },
  supportedActions: [
    'list-forums',
    'list-threads',
    'get-thread',
    'get-forum-summary',
    'sync-to-github',
    'create-post',
  ],
  description:
    'Traverse Discord forum channels, read discussions, and sync them to GitHub issues. Use list-forums to discover available forums, list-threads to see discussions, get-thread for full thread details, get-forum-summary for overview, sync-to-github to create GitHub issues from forum threads, and create-post to start a new post in a Room 302 forum.',
  requiredParams: [],
  examples: [
    '<capability name="discord-forums" action="list-threads" forumId="123456789" />',
    '<capability name="discord-forums" action="list-forums" />',
    '<capability name="discord-forums" action="get-thread" threadId="987654321" />',
    '<capability name="discord-forums" action="sync-to-github" forumId="123456789" repo="owner/repo" />',
  ],
  handler,
};

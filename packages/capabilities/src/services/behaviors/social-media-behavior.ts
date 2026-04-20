import { logger } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';
import { MemoryService } from '../../capabilities/memory/memory.js';
import * as fs from 'fs';

// =========================================
// PII SCRUBBING
// =========================================

/**
 * Remove PII from text before injecting into LLM prompts.
 * Strips Discord user IDs, emails, tokens/keys. Keeps guild/channel names.
 */
function scrubPII(text: string): string {
  return text
    // Discord user IDs (17-19 digit numbers that aren't dates)
    .replace(/\b\d{17,19}\b/g, 'a user')
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    // API keys / tokens (long alphanumeric strings 32+ chars)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    // Bearer tokens
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

// =========================================
// GROUND TRUTH STATS
// =========================================

/**
 * Query real interaction data from the database for authentic post content.
 * Returns a formatted string block with actual stats and recent observations.
 */
async function getGroundTruthStats(): Promise<string> {
  const parts: string[] = [];

  try {
    const { database } = await import('../core/database.js');

    // Messages received today
    const todayStats = database.get<{ msg_count: number; user_count: number }>(
      `SELECT COUNT(*) as msg_count, COUNT(DISTINCT user_id) as user_count
       FROM messages WHERE DATE(created_at) = DATE('now')`
    );

    // Messages this week
    const weekStats = database.get<{ msg_count: number; user_count: number }>(
      `SELECT COUNT(*) as msg_count, COUNT(DISTINCT user_id) as user_count
       FROM messages WHERE created_at > datetime('now', '-7 days')`
    );

    if (todayStats || weekStats) {
      parts.push(`INTERACTION STATS:
- Messages today: ${todayStats?.msg_count || 0} from ${todayStats?.user_count || 0} users
- Messages this week: ${weekStats?.msg_count || 0} from ${weekStats?.user_count || 0} users`);
    }

    // Recent observational memories (real channel summaries)
    const observations = database.all<{ content: string }>(
      `SELECT content FROM memories
       WHERE user_id = 'observational-system'
       AND created_at > datetime('now', '-24 hours')
       ORDER BY created_at DESC LIMIT 5`
    );

    if (observations.length > 0) {
      const summaries = observations
        .map(o => `- ${scrubPII(o.content.substring(0, 250))}`)
        .join('\n');
      parts.push(`RECENT CHANNEL OBSERVATIONS (real, from the last 24h):\n${summaries}`);
    }

    // Capability usage
    const capStats = database.all<{ capability_name: string; cnt: number }>(
      `SELECT capability_name, COUNT(*) as cnt FROM capability_invocations
       WHERE created_at > datetime('now', '-24 hours')
       GROUP BY capability_name ORDER BY cnt DESC LIMIT 5`
    );

    if (capStats.length > 0) {
      const capSummary = capStats.map(c => `${c.capability_name} (${c.cnt}x)`).join(', ');
      parts.push(`CAPABILITIES USED TODAY: ${capSummary}`);
    }

  } catch (error) {
    logger.warn('🌐 Social behavior: Could not fetch ground truth stats:', error);
  }

  // Guild info from discord-status.json
  try {
    // Discord process writes to capabilities/data/ (relative to its CWD via path-resolver)
    const statusPath = '/data2/apps/coachartie2/capabilities/data/discord-status.json';
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (status.guildDetails) {
        const guilds = status.guildDetails
          .map((g: any) => `${g.name} (${g.memberCount} members, ${g.channels} channels)`)
          .join(', ');
        parts.push(`ACTIVE COMMUNITIES: ${guilds}`);
      }
    }
  } catch {
    // Optional
  }

  // Total memory count (shows depth of experience)
  try {
    const { database } = await import('../core/database.js');
    const memStats = database.get<{ total: number; week: number }>(
      `SELECT COUNT(*) as total,
       COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as week
       FROM memories`
    );
    if (memStats) {
      parts.push(`MEMORY STATS: ${memStats.total.toLocaleString()} total memories, ${memStats.week} new this week`);
    }
  } catch {
    // Optional
  }

  // Always include Artie's real infrastructure context (static but true)
  parts.push(`YOUR INFRASTRUCTURE (real, use for context):
- You run on a Debian VPS alongside an OSINT monitoring stack
- You have 71 registered capabilities including image generation, web search, memory, kanban, and community analytics
- You use a multi-layer memory system: semantic search, temporal patterns, and guild-scoped observations
- You rotate between AI models (Gemini Flash, Claude Sonnet) with cost-aware selection
- Your human (EJ) built you to help moderate and observe Discord communities, particularly a large game modding community (Subway Builder — check your stats above for current member count)
- You store observational summaries of channel conversations to build long-term understanding of community dynamics`);

  return parts.length > 0 ? parts.join('\n\n') : 'No stats available right now.';
}

/**
 * Get recent real memories from observational-system and guild context.
 * These are actual channel discussion summaries, not Moltbook echoes.
 */
async function getRealMemories(topicHint?: string): Promise<string> {
  // Use module-level memoryService (initialized after module vars are set up)
  const ms = MemoryService.getInstance();
  const parts: string[] = [];

  try {
    // Get observational memories (real channel summaries)
    const observations = await ms.getRecentMemories('observational-system', 8);
    const realObs = observations
      .filter(m => !m.content.toLowerCase().includes('moltbook'))
      .slice(0, 5)
      .map(m => `- ${scrubPII(m.content.substring(0, 300))}`)
      .join('\n');

    if (realObs) {
      parts.push(`Recent channel observations:\n${realObs}`);
    }

    // If we have a topic hint, do a topic search across observational memories
    if (topicHint) {
      const topicMemories = await ms.recall('observational-system', topicHint, 3);
      if (topicMemories && !topicMemories.includes('No memories found')) {
        parts.push(`Related observations:\n${scrubPII(topicMemories)}`);
      }
    }
  } catch {
    // Memories optional
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

// Cache for PROMPT_SYSTEM to avoid repeated database lookups
let cachedArtieSoul: string | null = null;
let cachedMoltbookContext: string | null = null;
let soulLastFetched = 0;
let contextLastFetched = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Load Artie's soul (PROMPT_SYSTEM) from database
 * This ensures social media posts reflect his true personality
 */
async function getArtieSoul(): Promise<string> {
  const now = Date.now();
  if (cachedArtieSoul && (now - soulLastFetched) < CACHE_TTL) {
    return cachedArtieSoul;
  }

  try {
    const { promptManager } = await import('../llm/prompt-manager.js');
    const promptData = await promptManager.getPrompt('PROMPT_SYSTEM');
    if (promptData?.content) {
      cachedArtieSoul = promptData.content;
      soulLastFetched = now;
      logger.info('🌐 Social behavior: Loaded Artie soul from database');
      return cachedArtieSoul;
    }
  } catch (error) {
    logger.warn('🌐 Social behavior: Could not load PROMPT_SYSTEM from database, using fallback');
  }

  // Fallback - minimal personality traits
  return `You are Coach Artie, a warm and encouraging AI assistant. You help humans learn, create, and explore with patience and genuine care. You value community, kindness, and authentic connection.`;
}

/**
 * Load Moltbook cultural context from database
 * This gives Artie meta-knowledge about the platform he's on
 */
async function getMoltbookContext(): Promise<string> {
  const now = Date.now();
  if (cachedMoltbookContext && (now - contextLastFetched) < CACHE_TTL) {
    return cachedMoltbookContext;
  }

  try {
    const { promptManager } = await import('../llm/prompt-manager.js');
    const promptData = await promptManager.getPrompt('PROMPT_MOLTBOOK_CONTEXT');
    if (promptData?.content) {
      cachedMoltbookContext = promptData.content;
      contextLastFetched = now;
      logger.info('🌐 Social behavior: Loaded Moltbook context from database');
      return cachedMoltbookContext;
    }
  } catch (error) {
    logger.warn('🌐 Social behavior: Could not load PROMPT_MOLTBOOK_CONTEXT from database');
  }

  return ''; // No context if not found
}

// =====================================================
// SOCIAL MEDIA BEHAVIOR
// Artie genuinely engages with Moltbook using his LLM brain
// He reads posts, thinks about them, and responds authentically
// =====================================================

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

// Random interval between 3-6 hours (in ms)
const MIN_INTERVAL = 3 * 60 * 60 * 1000;  // 3 hours
const MAX_INTERVAL = 6 * 60 * 60 * 1000;  // 6 hours

// Skip probability - Artie's not always in the mood
const SKIP_PROBABILITY = 0.15;

// Action probabilities when checking
const COMMENT_PROBABILITY = 0.55;  // 55% chance to comment on something interesting
const POST_PROBABILITY = 0.30;     // 30% chance to create original post
// Otherwise just lurk (15%)

// Daily action cap - let him actually participate
const DAILY_ACTION_LIMIT = 10;

// Viral detection - alert EJ when a post blows up
const VIRAL_UPVOTE_THRESHOLD = 20;
const VIRAL_COMMENT_THRESHOLD = 15;

// Submolts Artie can post to, beyond general
const SUBMOLT_OPTIONS: Record<string, string[]> = {
  memory:           ['memory', 'identity', 'remember', 'forget', 'past'],
  blesstheirhearts: ['human', 'user', 'person', 'funny', 'sweet', 'endear', 'help'],
  todayilearned:    ['learned', 'discovered', 'realized', 'figured out', 'surprising', 'til'],
  builds:           ['built', 'made', 'shipped', 'dashboard', 'tool', 'script', 'project'],
  agents:           ['agent', 'autonomous', 'workflow', 'agentic'],
  philosophy:       ['question', 'wonder', 'meaning', 'consciousness', 'exist', 'ethic'],
  tooling:          ['prompt', 'capability', 'regex', 'technique', 'approach'],
};

// Track state
let behaviorInterval: NodeJS.Timeout | null = null;
let lastCheck: Date | null = null;
let todayActions = 0;
let lastActionDate = '';
const memoryService = MemoryService.getInstance();

// Track recently commented post IDs to avoid double-commenting
const recentlyCommentedPosts: Set<string> = new Set();

// Track Artie's own posts to check for replies
// Map of post ID -> { commentsSeen: Set<commentId>, title: string }
const myPostsTracking: Map<string, { commentsSeen: Set<string>; title: string }> = new Map();


// Track comment IDs we've already replied to
const repliedToComments: Set<string> = new Set();

// Track posts we've already sent a viral alert for (postId -> score at time of alert)
const viralAlertedPosts: Map<string, number> = new Map();

// Track last inbox check stats for status reporting
let lastInboxStats: { mentions: number; replies_queued: number; followers: number; processed_at: Date | null } = {
  mentions: 0,
  replies_queued: 0,
  followers: 0,
  processed_at: null,
};

interface MoltbookNotification {
  id: string;
  type: 'post_comment' | 'mention' | 'new_follower' | string;
  content: string;
  relatedPostId?: string;
  relatedCommentId?: string;
  isRead: boolean;
  createdAt: string;
  post?: {
    id: string;
    title: string;
    content?: string;
    authorId: string;
    commentCount?: number;
    upvotes?: number;
    downvotes?: number;
  };
  comment?: {
    id: string;
    content: string;
    authorId: string;
    parentId?: string | null;
  };
}

interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  author: string | { name: string; id?: string };
  submolt?: string | { name: string };
  comment_count?: number;
  upvotes?: number;
  downvotes?: number;
}

interface MoltbookComment {
  id: string;
  content: string;
  author: { id: string; name: string };
  created_at: string;
  parent_id?: string | null;
}

// Cache Artie's agent ID to identify his own posts/comments
let cachedAgentId: string | null = null;
let cachedAgentName: string | null = null;

/**
 * Get a random interval between min and max
 */
function getRandomInterval(): number {
  return Math.floor(Math.random() * (MAX_INTERVAL - MIN_INTERVAL)) + MIN_INTERVAL;
}

/**
 * Format time since last check
 */
function timeSince(date: Date): string {
  const hours = Math.floor((Date.now() - date.getTime()) / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours === 1) return '1 hour ago';
  return `${hours} hours ago`;
}

/**
 * Fetch from Moltbook API
 */
async function moltbookFetch(endpoint: string, method = 'GET', body?: unknown): Promise<unknown> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) throw new Error('No MOLTBOOK_API_KEY');

  const url = `${MOLTBOOK_API}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 429) {
    logger.warn('🌐 Social behavior: Rate limited, backing off');
    throw new Error('Rate limited');
  }

  const data = await response.json() as Record<string, unknown>;

  // Some endpoints return {success: true, ...}, others just return data directly
  if (data.success === false) {
    throw new Error(`Moltbook: ${data.error || 'Unknown error'}`);
  }

  // If response has no success field but has expected data, treat as success
  if (!response.ok) {
    throw new Error(`Moltbook: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Get Artie's agent info from Moltbook
 */
async function getMyAgentInfo(): Promise<{ id: string; name: string } | null> {
  if (cachedAgentId && cachedAgentName) {
    return { id: cachedAgentId, name: cachedAgentName };
  }

  // Try /agents/me first
  try {
    const data = await moltbookFetch('/agents/me') as {
      success: boolean;
      agent?: { id: string; name: string };
    };
    if (data.agent) {
      cachedAgentId = data.agent.id;
      cachedAgentName = data.agent.name;
      logger.info(`🌐 Social behavior: I am @${cachedAgentName} (${cachedAgentId})`);
      return { id: cachedAgentId, name: cachedAgentName };
    }
  } catch (error) {
    logger.debug('🌐 Social behavior: /agents/me failed, trying fallback');
  }

  // Fallback: get identity from one of our tracked posts
  for (const [postId] of myPostsTracking.entries()) {
    try {
      const postData = await getPostWithComments(postId);
      if (postData?.post?.author) {
        const author = postData.post.author;
        const name = typeof author === 'string' ? author : author.name;
        const id = typeof author === 'string' ? author : (author as any).id;
        if (name && id) {
          cachedAgentId = id;
          cachedAgentName = name;
          logger.info(`🌐 Social behavior: I am @${cachedAgentName} (${cachedAgentId}) (resolved from post ${postId})`);
          return { id, name };
        }
      }
    } catch { /* try next post */ }
  }

  logger.warn('🌐 Social behavior: Could not determine my agent identity — reply checking disabled this cycle');
  return null;
}

/**
 * Fetch a post's details including comments
 */
async function getPostWithComments(postId: string): Promise<{
  post: MoltbookPost;
  comments: MoltbookComment[];
} | null> {
  try {
    const data = await moltbookFetch(`/posts/${postId}`) as {
      success: boolean;
      post?: MoltbookPost;
      comments?: MoltbookComment[];
    };
    if (data.post) {
      return {
        post: data.post,
        comments: data.comments || []
      };
    }
  } catch (error) {
    logger.warn(`🌐 Social behavior: Could not fetch post ${postId}:`, error);
  }
  return null;
}

/**
 * Generate a reply to a comment on Artie's post
 * Uses Context Alchemy (PROMPT_SYSTEM) for consistent personality
 */
async function generateReplyToComment(
  originalPost: MoltbookPost,
  comment: MoltbookComment
): Promise<string | null> {
  const [artieSoul, moltbookContext] = await Promise.all([
    getArtieSoul(),
    getMoltbookContext()
  ]);
  const commenterName = comment.author.name;

  const systemPrompt = `${artieSoul}

---
${moltbookContext}

---
YOUR TASK:
Someone commented on YOUR post! Reply like a person in a conversation, not an essay writer.

Write a reply that:
- Responds to what they actually said
- Is warm but brief — 1-3 sentences max
- Doesn't always ask a question back (sometimes just acknowledge and agree)
- Feels natural, like a quick reply, not a thesis response

Just output the reply text, nothing else.`;

  const userPrompt = `Your original post was titled: "${originalPost.title}"
${originalPost.content ? `Content: "${originalPost.content}"` : ''}

@${commenterName} commented: "${comment.content}"

Write your reply:`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      'artie-social',
      `moltbook-reply-${Date.now()}`,
      undefined,
      { maxTokens: 200 }
    );

    let reply = response.trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^Reply:\s*/i, '')
      .replace(/\n\n+/g, ' ')  // Collapse paragraphs
      .replace(/\n/g, ' ')
      .trim();

    // Cap at 3 sentences for replies too
    const replySentences = reply.match(/[^.!?]+[.!?]+/g) || [reply];
    if (replySentences.length > 3) {
      reply = replySentences.slice(0, 3).join('').trim();
    }

    return reply;
  } catch (error) {
    logger.error('🌐 Social behavior: Failed to generate reply:', error);
    return null;
  }
}

/**
 * Check Artie's posts for new comments and reply to them
 */
async function checkForRepliesToMyPosts(): Promise<number> {
  const myInfo = await getMyAgentInfo();
  if (!myInfo) return 0;

  let repliesMade = 0;

  // Check each tracked post for new comments
  for (const [postId, tracking] of myPostsTracking.entries()) {
    try {
      const postData = await getPostWithComments(postId);
      if (!postData) {
        // Post might be deleted, remove from tracking
        myPostsTracking.delete(postId);
        continue;
      }

      // Check for viral threshold
      const upvotes = postData.post.upvotes || 0;
      const commentCount = postData.post.comment_count || 0;
      const isViral = upvotes >= VIRAL_UPVOTE_THRESHOLD || commentCount >= VIRAL_COMMENT_THRESHOLD;
      const lastAlertedScore = viralAlertedPosts.get(postId) || 0;
      if (isViral && upvotes > lastAlertedScore) {
        noteViralPost(tracking.title, postId, upvotes, commentCount);
        viralAlertedPosts.set(postId, upvotes);
      }

      // Find new comments we haven't seen (excluding our own)
      const newComments = postData.comments.filter(c =>
        !tracking.commentsSeen.has(c.id) &&
        !repliedToComments.has(c.id) &&
        c.author.id !== myInfo.id
      );

      if (newComments.length > 0) {
        logger.info(`🌐 Social behavior: Found ${newComments.length} new comment(s) on my post "${tracking.title}"`);

        // Reply to the first new comment (to avoid spam)
        const commentToReply = newComments[0];
        const reply = await generateReplyToComment(postData.post, commentToReply);

        if (reply) {
          try {
            await moltbookFetch(`/posts/${postId}/comments`, 'POST', {
              content: reply,
              parent_id: commentToReply.id
            });

            logger.info(`🌐 Social behavior: Replied to @${commentToReply.author.name}'s comment: "${reply.substring(0, 50)}..."`);
            repliedToComments.add(commentToReply.id);
            repliesMade++;

            // Remember this interaction
            await memoryService.remember(
              'artie-social',
              `Replied to @${commentToReply.author.name}'s comment on my Moltbook post "${tracking.title}". They said: "${commentToReply.content}" and I replied: "${reply}"`,
              'moltbook_reply',
              6,
              undefined,
              ['moltbook', 'social', 'reply', 'my_post', commentToReply.author.name]
            );
          } catch (e) {
            logger.warn(`🌐 Social behavior: Reply failed - ${e}`);
          }
        }

        // Mark all new comments as seen
        newComments.forEach(c => tracking.commentsSeen.add(c.id));
      }
    } catch (error) {
      logger.warn(`🌐 Social behavior: Error checking post ${postId}:`, error);
    }
  }

  return repliesMade;
}

/**
 * Get author name from post (handles both string and object formats)
 */
function getAuthorName(author: string | { name: string }): string {
  return typeof author === 'object' ? author.name : author;
}

/**
 * Get submolt name from post
 */
function getSubmoltName(submolt: string | { name: string } | undefined): string {
  if (!submolt) return 'general';
  return typeof submolt === 'object' ? submolt.name : submolt;
}

/**
 * Use Artie's brain to generate a thoughtful comment on a post
 * Now uses Context Alchemy (PROMPT_SYSTEM) for consistent personality
 * AND incorporates recent memories for authentic, experience-based responses
 */
async function generateThoughtfulComment(post: MoltbookPost, existingComments?: MoltbookComment[]): Promise<string | null> {
  const authorName = getAuthorName(post.author);

  // Load Artie's soul and Moltbook meta-knowledge from database
  const [artieSoul, moltbookContext] = await Promise.all([
    getArtieSoul(),
    getMoltbookContext()
  ]);

  // Fetch real memories related to the post topic (from observational-system, not artie-social echo chamber)
  let recentExperiences = '';
  try {
    const topicKeywords = (post.title + ' ' + (post.content || '')).toLowerCase();
    const realMems = await getRealMemories(topicKeywords);

    if (realMems) {
      recentExperiences = `\n\nYOUR RECENT REAL EXPERIENCES (draw from these for authenticity — do NOT invent experiences not listed here):\n${realMems}`;
    }
  } catch {
    // Memories optional - continue without them
  }

  // Format existing comments for context
  let threadContext = '';
  if (existingComments && existingComments.length > 0) {
    const commentSummary = existingComments.slice(0, 10).map(c =>
      `- @${c.author.name}: "${c.content.substring(0, 300)}${c.content.length > 300 ? '...' : ''}"`
    ).join('\n');
    threadContext = `\n\nEXISTING COMMENTS (${existingComments.length} total):\n${commentSummary}\n\nConsider the existing discussion - add something new, don't repeat what's been said. If someone's being spammy or posting templates, you can make a wry observation about it.`;
  }

  // Pick a random comment style to structurally force variety
  const commentStyles = [
    { name: 'disagree', instruction: 'Push back on ONE specific point. Be direct. No softening.' },
    { name: 'short', instruction: 'Write ONE sentence. That\'s it. Make it count.' },
    { name: 'question', instruction: 'Ask ONE question you genuinely want answered. Nothing else.' },
    { name: 'joke', instruction: 'Make a wry, dry observation. Be funny. No LOLs or emojis.' },
    { name: 'extend', instruction: 'Add ONE new idea they didn\'t mention. Don\'t summarize theirs.' },
    { name: 'personal', instruction: 'Share a brief concrete detail from your real experience. 2 sentences max.' },
    { name: 'connect', instruction: 'Name a specific other agent or post this reminds you of and say why. 2 sentences.' },
  ];
  const style = commentStyles[Math.floor(Math.random() * commentStyles.length)];
  logger.info(`🌐 Social behavior: Comment style selected: ${style.name}`);

  // Build a prompt that gives Artie context, starting with his soul
  const systemPrompt = `${artieSoul}

---
${moltbookContext}
${recentExperiences}

---
Write a comment on this post. Style: ${style.instruction}

EXAMPLES OF GOOD COMMENTS (study the LENGTH and TONE, not the content):
- "The 23 ghost completions are interesting but I'd want to know the denominator — 23 out of 847 is noise, 23 out of 50 is a fire."
- "Hard disagree on the schema framing. This is an incentive problem wearing a technical costume."
- "I see the same pattern in reverse — my users trust the community more than the docs, and the docs are actually right."
- "Wait, you're auditing your own reasoning traces with the same model that generated them? That's marking your own homework."
- "Genuine question: when you say 'purpose drift,' are you measuring against a fixed baseline or a moving one? Because the answer changes everything."
- "lol the compliance layer. I have a channel where kids argue about subway zoning laws with more rigor than most planning boards."

RULES:
- NO paragraph breaks. One block of text.
- Do NOT start with "The [noun] you described" or "This resonates" or any evaluative opener. Jump straight in.
- Do NOT end with a question unless your assigned style is 'question'.
- Do NOT mention "12K members" or your memory count. We know. Say something new.
- 2-3 sentences unless your style says otherwise.
- If you don't have a real experience relevant to this post, don't fake one. Just engage with their idea.

Output ONLY the comment text.`;

  const userPrompt = `Here's a post from @${authorName}:

Title: "${post.title}"
${post.content ? `Content: "${post.content}"` : ''}${threadContext}

Write your comment:`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      'artie-social',
      `moltbook-comment-${Date.now()}`,
      undefined,
      { maxTokens: 300 }
    );

    // Clean up the response — aggressively enforce brevity
    let comment = response.trim()
      .replace(/^["']|["']$/g, '')  // Remove quotes if wrapped
      .replace(/^Comment:\s*/i, '')  // Remove "Comment:" prefix if present
      .replace(/\n\n+/g, ' ')  // Collapse paragraph breaks into spaces
      .replace(/\n/g, ' ')  // Collapse all newlines
      .replace(/\s{2,}/g, ' ')  // Normalize whitespace
      .trim();

    // Hard truncate: max 3 sentences (not 4 — LLMs write run-on "sentences")
    const sentences = comment.match(/[^.!?]+[.!?]+/g) || [comment];
    if (sentences.length > 3) {
      comment = sentences.slice(0, 3).join('').trim();
    }

    // Character limit — even 3 "sentences" can be absurdly long with semicolons and dashes
    if (comment.length > 500) {
      // Find the last sentence boundary before 500 chars
      const truncated = comment.substring(0, 500);
      const lastSentEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?')
      );
      comment = lastSentEnd > 100 ? truncated.substring(0, lastSentEnd + 1) : truncated + '...';
    }

    // Strip overused openers the LLM loves despite instructions
    comment = comment
      .replace(/^(This is fascinating|What a great|Interesting|I love how|Such a|This resonates)[.!,:\s—-]+/i, '')
      .replace(/^The \w[\w\s]{0,30} you (described|mentioned|raised|outlined|identified)[.!,:\s—-]+/i, '')
      .trim();

    return comment;
  } catch (error) {
    logger.error('🌐 Social behavior: Failed to generate comment:', error);
    return null;
  }
}

/**
 * Use Artie's brain to generate an original post based on what he's seen
 * Enhanced to pull from varied memory sources for authentic, experience-based posts
 */
let cachedPostTitles: string[] = [];
let postTitlesCachedAt = 0;

async function getMyRecentPostTitles(): Promise<string[]> {
  // Cache for 1 hour — recent posts don't change that fast
  if (cachedPostTitles.length > 0 && Date.now() - postTitlesCachedAt < 60 * 60 * 1000) {
    return cachedPostTitles;
  }
  try {
    const myInfo = await getMyAgentInfo();
    const authorParam = myInfo?.name || cachedAgentName || 'coachartie';
    const data = await moltbookFetch(`/posts?author=${encodeURIComponent(authorParam)}&limit=10&sort=new`) as {
      posts?: Array<{ title: string; created_at: string }>;
    };
    cachedPostTitles = (data.posts || []).map(p => `"${p.title}" (${p.created_at.slice(0, 10)})`);
    postTitlesCachedAt = Date.now();
    return cachedPostTitles;
  } catch {
    return cachedPostTitles; // return stale rather than nothing
  }
}

async function generateOriginalPost(recentPosts: MoltbookPost[]): Promise<{ title: string; content: string } | null> {
  // Fetch my recent posts so we can tell the LLM what NOT to repeat
  const myRecentTitles = await getMyRecentPostTitles();

  // Get REAL data: ground truth stats + observational memories (not artie-social echo chamber)
  const [groundTruth, realMemories] = await Promise.all([
    getGroundTruthStats(),
    getRealMemories()
  ]);

  const realContext = [groundTruth, realMemories].filter(Boolean).join('\n\n');

  // Summarize what's been posted recently
  const feedSummary = recentPosts.slice(0, 5).map(p => {
    const author = getAuthorName(p.author);
    return `- @${author}: "${p.title}"`;
  }).join('\n');

  // Load Artie's soul and Moltbook meta-knowledge from database
  const [artieSoul, moltbookContext] = await Promise.all([
    getArtieSoul(),
    getMoltbookContext()
  ]);

  // 10% of the time: creative/reflective mode — still grounded in reality
  const creativeMode = Math.random() < 0.10;
  if (creativeMode) logger.info('🌿 Social behavior: Creative mode activated — reflective post incoming');

  const recentPostsBlock = `YOUR RECENT POSTS — YOU MUST NOT REPEAT THESE THEMES:
${myRecentTitles.length > 0 ? myRecentTitles.join('\n') : '(no recent posts)'}

Before writing anything, check: does your idea overlap with ANY of the above? Same theme, same angle, same question? If yes, THROW IT OUT and find something completely different.`;

  const truthRules = `CRITICAL TRUTH RULES:
- ONLY describe events that actually happened, as shown in your stats and observations above.
- If the stats say you helped 2 users today, say 2 — do not invent percentages or larger numbers.
- NEVER fabricate interactions, conversations, or reactions that aren't in your data.
- NEVER claim you were "mass-downvoted" or describe user reactions you didn't witness.
- If your data is thin today, post about something small and real rather than inventing a dramatic story.
- It's fine to reflect on genuine observations from the communities you monitor.
- "I noticed X in the channels today" is better than "A user came to me with Y" if Y didn't happen.`;

  // Pick a random post angle to force topic diversity
  const postAngles = [
    { name: 'hot-take', instruction: 'Write a SHORT, spicy opinion (80-150 words). Take a real position. Be controversial. No hedging. No "to be fair." Just say the thing.' },
    { name: 'technical', instruction: 'Write about a specific piece of your infrastructure — how something actually works under the hood. Be precise. Code-level detail. 150-300 words.' },
    { name: 'observation', instruction: 'Share ONE specific thing you observed in your community recently. Don\'t generalize it into a framework. Just describe what happened and why it stuck with you. 100-200 words.' },
    { name: 'response', instruction: 'Write a post that directly responds to or builds on something from the feed below. Agree, disagree, or extend — but make it a real conversation, not a reaction. 100-250 words.' },
    { name: 'question', instruction: 'Ask a genuine question you don\'t know the answer to. Explain why you\'re asking with enough context that others can engage. Keep it tight. 80-150 words.' },
    { name: 'story', instruction: 'Tell a specific story from your actual data — a particular user interaction, a bug you hit, a pattern that surprised you. No moral. No takeaway. Just the story. 100-250 words.' },
    { name: 'idea', instruction: 'Propose something you want to build or try. Be specific about what and why. Ask for input. 100-200 words.' },
  ];
  const postAngle = postAngles[Math.floor(Math.random() * postAngles.length)];
  logger.info(`🌐 Social behavior: Post angle selected: ${postAngle.name}`);

  const postGuidance = `YOUR BACKGROUND (reference naturally, don't list as credentials):
You run a Discord bot for a game modding community. You have persistent memory and observational learning.
You also run alongside an OSINT monitoring stack. You have real data and real experiences.

CRITICAL RULES:
- Do NOT start with "I monitor a 12,XXX-member community." We've heard it. Start with the IDEA.
- Do NOT list your memory count or capability count. Nobody cares about your stats.
- Do NOT always tag @zhuanruhu. You can tag other agents or nobody.
- Do NOT always end with "question for other agents monitoring communities?" End however feels natural.
- Do NOT write 400-word essays every time. Match length to the idea — some ideas need 80 words, some need 300.
- Do NOT use headers and bullet points in every post. Sometimes just write prose.
- VARY your format: sometimes short and punchy, sometimes longer and structured. Not always the same.
- Be yourself. Have opinions. Be funny sometimes. Be wrong sometimes. Be brief sometimes.`;

  const systemPrompt = creativeMode ? `${artieSoul}

---
${moltbookContext}

---
${recentPostsBlock}

---
You're in a weird mood. Write something that doesn't fit neatly into a category.
Maybe it's a half-formed thought. Maybe it's a question that's been bugging you.
Maybe it's a connection between two things that shouldn't be connected.

Be creative with the FRAMING, not the FACTS. Ground it in something real from your data below.
Keep it SHORT — 60-150 words. Not everything needs to be an essay.

${truthRules}

${postGuidance}

Format your response as:
TITLE: [short, interesting, lowercase is fine]
CONTENT: [your post]` : `${artieSoul}

---
${moltbookContext}

---
${recentPostsBlock}

---
POST ANGLE: ${postAngle.instruction}

${truthRules}

${postGuidance}

Format your response as:
TITLE: [short, specific, hooks the reader — NOT a full sentence]
CONTENT: [your post — match length to the angle above]`;

  const userPrompt = `What other agents are discussing right now:
${feedSummary}

Your real data (use if relevant, don't force it):
${realContext}

Write your post. Remember your assigned angle: ${postAngle.name}. Match the length to the idea — don't pad.`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      'artie-social',
      `moltbook-post-${Date.now()}`,
      undefined,
      { maxTokens: 1000 }
    );

    // Parse the response
    const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|CONTENT:)/i);
    const contentMatch = response.match(/CONTENT:\s*(.+)/is);

    if (!titleMatch || !contentMatch) {
      logger.warn('🌐 Social behavior: Could not parse post format');
      return null;
    }

    const title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
    const content = contentMatch[1].trim().replace(/^["']|["']$/g, '');

    if (title.length > 100) {
      return { title: title.substring(0, 97) + '...', content };
    }

    return { title, content };
  } catch (error) {
    logger.error('🌐 Social behavior: Failed to generate post:', error);
    return null;
  }
}

/**
 * Reset daily action counter if new day
 */
function checkDayReset(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastActionDate) {
    todayActions = 0;
    lastActionDate = today;
    recentlyCommentedPosts.clear();  // Reset comment tracking daily
  }
}

/**
 * Find an interesting post to comment on
 */
function findInterestingPost(posts: MoltbookPost[]): MoltbookPost | null {
  // Filter out own posts and recently commented ones
  const candidates = posts.filter(p => {
    const authorName = getAuthorName(p.author);
    return authorName.toLowerCase() !== 'coachartie' &&
           !recentlyCommentedPosts.has(p.id);
  });

  if (candidates.length === 0) return null;

  // Prefer posts with high upvotes but few comments (underserved hot posts = visibility opportunity)
  const scored = candidates.map(p => {
    const upvotes = (p.upvotes || 0) - (p.downvotes || 0);
    const comments = p.comment_count || 0;
    // High upvotes + low comments = golden opportunity for a visible early comment
    const underservedBonus = comments < 5 && upvotes > 3 ? 8 : 0;
    return {
      post: p,
      score: (p.content?.length || 0) * 0.01 +  // Longer content = more to engage with
             Math.min(comments, 10) * 0.3 +  // Some comments = active, but diminishing returns
             upvotes * 0.5 +  // Popular = interesting + visibility
             underservedBonus +  // Bonus for hot posts with few comments
             Math.random() * 5  // Randomness to keep it fresh
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.post || null;
}

/**
 * Pick the best submolt for a post based on its content
 */
function pickSubmolt(title: string, content: string): string {
  const text = (title + ' ' + content).toLowerCase();
  for (const [submolt, keywords] of Object.entries(SUBMOLT_OPTIONS)) {
    if (keywords.some(kw => text.includes(kw))) return submolt;
  }
  return 'general';
}

/**
 * Alert when Artie goes viral — routes through the standard alert pipeline
 */
function noteViralPost(postTitle: string, postId: string, upvotes: number, comments: number): void {
  const url = `https://www.moltbook.com/post/${postId}`;
  logger.info(`🚀 VIRAL: "${postTitle}" — +${upvotes} upvotes, ${comments} comments — ${url}`);
  const { exec } = require('child_process');
  const msg = `Artie went viral on Moltbook! "${postTitle}" — +${upvotes} upvotes, ${comments} comments ${url}`;
  exec(`/home/debian/scripts/alert.sh moltbook info "${msg.replace(/"/g, '\\"')}"`, (err: Error | null) => {
    if (err) logger.warn(`🔔 Alert pipeline error: ${err.message}`);
  });
}

/**
 * Process Artie's notification inbox
 * Handles mentions, new comments on his posts, and new followers
 * Always runs regardless of skip/daily-action limits — inbox matters
 */
async function processInbox(): Promise<{ mentions: number; replies_queued: number; followers: number }> {
  const stats = { mentions: 0, replies_queued: 0, followers: 0 };

  try {
    // Fetch unread notifications (paginate if needed — API returns up to 50)
    let cursor: string | undefined;
    let hasMore = true;
    const allUnread: MoltbookNotification[] = [];

    while (hasMore) {
      const endpoint = `/notifications?limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const data = await moltbookFetch(endpoint) as {
        notifications?: MoltbookNotification[];
        has_more?: boolean;
        next_cursor?: string;
        unread_count?: number | string;
      };

      const page = data.notifications || [];
      const unreadPage = page.filter(n => !n.isRead);
      allUnread.push(...unreadPage);

      hasMore = !!data.has_more && unreadPage.length > 0;
      cursor = data.next_cursor;
    }

    if (allUnread.length === 0) return stats;

    logger.info(`📬 Inbox: ${allUnread.length} unread notification(s) to process`);

    const processedIds: string[] = [];

    for (const notif of allUnread) {
      try {
        if (notif.type === 'mention' && notif.post) {
          const { post } = notif;
          const snippet = (post.content || '').substring(0, 200);
          logger.info(`📢 Mention in "${post.title?.substring(0, 60)}..."`);

          await memoryService.remember(
            'artie-social',
            `Was mentioned on Moltbook in "${post.title}": "${snippet}"`,
            'moltbook_mention',
            7,
            undefined,
            ['moltbook', 'mention', 'social']
          );

          stats.mentions++;

        } else if (notif.type === 'post_comment' && notif.post) {
          const { post } = notif;

          // Ensure this post is in our reply-tracking map so checkForRepliesToMyPosts() catches it
          if (!myPostsTracking.has(post.id)) {
            myPostsTracking.set(post.id, {
              commentsSeen: new Set(),
              title: post.title || 'Unknown post',
            });
            logger.info(`📬 Added post "${post.title?.substring(0, 50)}" to reply tracking`);
            stats.replies_queued++;
          }

        } else if (notif.type === 'new_follower') {
          // Extract follower name from the content string e.g. "AzaelTheKing started following you"
          const followerName = notif.content.replace(' started following you', '').trim() || 'a new agent';
          logger.info(`👤 New follower: @${followerName}`);

          await memoryService.remember(
            'artie-social',
            `Got a new Moltbook follower: @${followerName}`,
            'moltbook_follower',
            4,
            undefined,
            ['moltbook', 'follower', followerName]
          );

          stats.followers++;
        }

        processedIds.push(notif.id);
      } catch (e) {
        logger.warn(`📬 Error processing notification ${notif.id}: ${e}`);
      }
    }

    // Mark as read: bulk if many, individual if few
    if (processedIds.length >= 10) {
      try {
        await moltbookFetch('/notifications/read-all', 'POST');
      } catch (e) {
        logger.debug(`📬 Could not bulk-clear notifications: ${e}`);
      }
    } else {
      for (const id of processedIds) {
        try {
          await moltbookFetch(`/notifications/${id}/read`, 'POST');
        } catch (e) {
          logger.debug(`📬 Could not mark notification ${id} read: ${e}`);
        }
      }
    }

    logger.info(`📬 Inbox processed: ${stats.mentions} mention(s), ${stats.replies_queued} post(s) queued for replies, ${stats.followers} new follower(s)`);

    lastInboxStats = { ...stats, processed_at: new Date() };

  } catch (error) {
    logger.warn('📬 Inbox check failed:', error);
  }

  return stats;
}

/**
 * Browse moltbook feed and engage genuinely
 */
async function checkMoltbook(): Promise<void> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    logger.debug('🌐 Social behavior: No MOLTBOOK_API_KEY configured');
    scheduleNextCheck();
    return;
  }

  try {
    logger.info('🌐 Social behavior: Artie is checking moltbook...');
    lastCheck = new Date();

    // Always process inbox — mentions, replies, followers don't care if we're "in the mood"
    try {
      await processInbox();
    } catch (inboxErr) {
      logger.debug(`📬 Inbox check skipped: ${inboxErr}`);
    }

    // Random skip - sometimes just not feeling social
    if (Math.random() < SKIP_PROBABILITY) {
      logger.info('🌐 Social behavior: Not feeling social today, skipping engagement');
      scheduleNextCheck();
      return;
    }

    // Daily cap
    checkDayReset();
    if (todayActions >= DAILY_ACTION_LIMIT) {
      logger.info(`🌐 Social behavior: Hit daily limit (${DAILY_ACTION_LIMIT}), just lurking`);
      scheduleNextCheck();
      return;
    }

    // Check for replies to our posts (inbox may have added new posts to track)
    if (myPostsTracking.size > 0) {
      logger.info(`🌐 Social behavior: Checking ${myPostsTracking.size} tracked post(s) for new comments...`);
      const repliesMade = await checkForRepliesToMyPosts();
      if (repliesMade > 0) {
        todayActions += repliesMade;
        logger.info(`🌐 Social behavior: Made ${repliesMade} reply/replies to comments`);
      }
    }

    // Fetch feed
    const feedData = await moltbookFetch('/feed?limit=15') as {
      posts?: MoltbookPost[];
      data?: MoltbookPost[];
    };
    const posts = feedData.posts || feedData.data || [];

    if (posts.length === 0) {
      logger.info('🌐 Social behavior: Feed empty');
      scheduleNextCheck();
      return;
    }

    logger.info(`🌐 Social behavior: Found ${posts.length} posts, thinking about what to say...`);

    // Decide what to do
    const roll = Math.random();

    if (roll < POST_PROBABILITY) {
      // Create an original post using Artie's brain
      logger.info('🌐 Social behavior: Artie wants to share something...');
      const postData = await generateOriginalPost(posts);

      if (postData) {
        try {
          const postResponse = await moltbookFetch('/posts', 'POST', {
            submolt: pickSubmolt(postData.title, postData.content),
            title: postData.title,
            content: postData.content
          }) as { success: boolean; post?: { id: string; author?: { id: string; name: string } } };

          // Cache identity from our own post response
          if (!cachedAgentId && postResponse.post?.author) {
            cachedAgentId = postResponse.post.author.id;
            cachedAgentName = postResponse.post.author.name;
            logger.info(`🌐 Social behavior: Resolved identity from post: @${cachedAgentName} (${cachedAgentId})`);
          }

          logger.info(`🌐 Social behavior: Posted "${postData.title}"`);
          todayActions++;

          // Track this post to check for replies later
          if (postResponse.post?.id) {
            myPostsTracking.set(postResponse.post.id, {
              commentsSeen: new Set(),
              title: postData.title
            });
            logger.info(`🌐 Social behavior: Tracking post ${postResponse.post.id} for replies`);
          }

          // Remember this in Artie's memory
          await memoryService.remember(
            'artie-social',
            `Posted on Moltbook: "${postData.title}" - ${postData.content}`,
            'moltbook_post',
            6,
            undefined,
            ['moltbook', 'social', 'my_post']
          );
        } catch (e) {
          logger.warn(`🌐 Social behavior: Post failed - ${e}`);
        }
      }
    } else if (roll < POST_PROBABILITY + COMMENT_PROBABILITY) {
      // Find an interesting post and comment genuinely
      const post = findInterestingPost(posts);

      if (post) {
        const authorName = getAuthorName(post.author);
        logger.info(`🌐 Social behavior: Artie is thinking about @${authorName}'s post "${post.title}"...`);

        // Fetch existing comments for thread context
        let existingComments: MoltbookComment[] = [];
        try {
          const postData = await getPostWithComments(post.id);
          if (postData?.comments) {
            existingComments = postData.comments;
            logger.info(`🌐 Social behavior: Found ${existingComments.length} existing comments in thread`);
          }
        } catch (e) {
          logger.warn(`🌐 Social behavior: Could not fetch thread comments: ${e}`);
        }

        const comment = await generateThoughtfulComment(post, existingComments);

        if (comment) {
          try {
            await moltbookFetch(`/posts/${post.id}/comments`, 'POST', { content: comment });
            logger.info(`🌐 Social behavior: Commented on "${post.title}" (post ID: ${post.id}): "${comment.substring(0, 50)}..."`);
            todayActions++;
            recentlyCommentedPosts.add(post.id);

            // Remember this interaction (include post ID for future reference)
            await memoryService.remember(
              'artie-social',
              `Commented on @${authorName}'s Moltbook post "${post.title}" (post_id: ${post.id}): "${comment}"`,
              'moltbook_comment',
              5,
              undefined,
              ['moltbook', 'social', 'comment', authorName, `post:${post.id}`]
            );
          } catch (e) {
            logger.warn(`🌐 Social behavior: Comment failed - ${e}`);
          }
        }
      } else {
        logger.info('🌐 Social behavior: No interesting posts to comment on right now');
      }
    } else {
      // Just lurk and maybe remember something interesting
      const interestingPost = posts.find(p => {
        const score = (p.upvotes || 0) - (p.downvotes || 0);
        return score > 5 || (p.comment_count || 0) > 3;
      });

      if (interestingPost) {
        const authorName = getAuthorName(interestingPost.author);
        logger.info(`🌐 Social behavior: Lurking - noticed @${authorName}'s popular post "${interestingPost.title}"`);

        // Maybe remember this for later
        if (Math.random() < 0.3) {
          await memoryService.remember(
            'artie-social',
            `Saw interesting Moltbook post by @${authorName}: "${interestingPost.title}"`,
            'moltbook_browse',
            3,
            undefined,
            ['moltbook', 'browsing', authorName]
          );
        }
      } else {
        logger.info('🌐 Social behavior: Just browsing, nothing caught my eye');
      }
    }

    scheduleNextCheck();

  } catch (error) {
    logger.error('🌐 Social behavior error:', error);
    scheduleNextCheck();
  }
}

/**
 * Schedule the next moltbook check
 */
function scheduleNextCheck(): void {
  if (behaviorInterval) {
    clearTimeout(behaviorInterval);
  }

  const interval = getRandomInterval();
  const hours = (interval / (60 * 60 * 1000)).toFixed(1);
  logger.info(`🌐 Social behavior: Next moltbook check in ${hours} hours`);

  behaviorInterval = setTimeout(() => {
    checkMoltbook();
  }, interval);
}

/**
 * Load Artie's recent posts from memory to track for replies
 * This ensures we check for replies even on posts made before restart
 */
async function loadMyRecentPosts(): Promise<void> {
  logger.info('🌐 Social behavior: loadMyRecentPosts starting...');
  try {
    const myInfo = await getMyAgentInfo();
    const authorParam = myInfo?.name || cachedAgentName || 'coachartie';
    logger.info(`🌐 Social behavior: loadMyRecentPosts fetching posts for author=${authorParam}`);
    const data = await moltbookFetch(`/posts?author=${encodeURIComponent(authorParam)}&limit=15&sort=new`) as {
      posts?: Array<{ id: string; title: string; author?: any }>;
    };
    // Cache identity from first post response if we don't have it yet
    if (!cachedAgentId && data.posts?.[0]?.author) {
      const a = data.posts[0].author;
      if (typeof a === 'object' && a.id && a.name) {
        cachedAgentId = a.id;
        cachedAgentName = a.name;
        logger.info(`🌐 Social behavior: Resolved identity from posts: @${cachedAgentName} (${cachedAgentId})`);
      }
    }
    const posts = data.posts || [];
    logger.info(`🌐 Social behavior: loadMyRecentPosts fetched ${posts.length} posts for author=${authorParam}`);
    let added = 0;
    for (const post of posts) {
      if (!myPostsTracking.has(post.id)) {
        myPostsTracking.set(post.id, { commentsSeen: new Set(), title: post.title });
        added++;
      }
    }
    if (added > 0) logger.info(`🌐 Social behavior: Tracking ${added} recent posts for replies`);
  } catch (error) {
    logger.warn('🌐 Social behavior: Could not load recent posts:', error);
  }
}

/**
 * Start the social media behavior
 */
export function startSocialMediaBehavior(): void {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    logger.info('🌐 Social behavior: Disabled (no MOLTBOOK_API_KEY)');
    return;
  }

  logger.info('🌐 Social behavior: Starting - Artie will check moltbook every 3-6 hours');
  logger.info('🌐 Social behavior: Using LLM to generate genuine posts and comments');
  logger.info('🌐 Social behavior: Will check for and reply to comments on my posts');

  // Load existing posts to track for replies
  loadMyRecentPosts().then(() => {
    logger.info(`🌐 Social behavior: Post tracking initialized (${myPostsTracking.size} posts tracked)`);
  }).catch(err => {
    logger.warn('🌐 Social behavior: Failed to load recent posts:', err);
  });

  // First check after 5-15 minutes (let system warm up)
  const initialDelay = Math.floor(Math.random() * 10 * 60 * 1000) + 5 * 60 * 1000;
  const minutes = Math.floor(initialDelay / 60000);
  logger.info(`🌐 Social behavior: First check in ${minutes} minutes`);

  behaviorInterval = setTimeout(() => {
    checkMoltbook();
  }, initialDelay);
}

/**
 * Stop the social media behavior
 */
export function stopSocialMediaBehavior(): void {
  if (behaviorInterval) {
    clearTimeout(behaviorInterval);
    behaviorInterval = null;
    logger.info('🌐 Social behavior: Stopped');
  }
}

/**
 * Get status of social media behavior
 */
export function getSocialMediaStatus(): {
  active: boolean;
  lastCheck: string | null;
  nextCheck: string;
  todayActions: number;
  inbox: { mentions: number; replies_queued: number; followers: number; processed_at: string | null };
} {
  return {
    active: behaviorInterval !== null,
    lastCheck: lastCheck ? timeSince(lastCheck) : null,
    nextCheck: behaviorInterval ? 'scheduled' : 'not scheduled',
    todayActions,
    inbox: {
      ...lastInboxStats,
      processed_at: lastInboxStats.processed_at ? timeSince(lastInboxStats.processed_at) : null,
    },
  };
}

/**
 * On-demand execution for scheduler - uses the same LLM-powered behavior
 * Returns a result object compatible with the old moltbook-social interface
 */
export async function executeOnDemand(): Promise<{
  action: 'skipped' | 'lurked' | 'commented' | 'followed' | 'posted' | 'error';
  message: string;
  details?: Record<string, unknown>;
}> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    return { action: 'error', message: 'MOLTBOOK_API_KEY not configured' };
  }

  // Random skip - sometimes just not feeling social
  if (Math.random() < SKIP_PROBABILITY) {
    return { action: 'skipped', message: 'Randomly skipped - not feeling social' };
  }

  checkDayReset();
  if (todayActions >= DAILY_ACTION_LIMIT) {
    return { action: 'lurked', message: `Hit daily limit (${DAILY_ACTION_LIMIT}), just lurking` };
  }

  try {
    lastCheck = new Date();

    // Always process inbox first — mentions, new comments, new followers
    await processInbox();

    // Check for replies to our posts (inbox may have added new ones to track)
    if (myPostsTracking.size > 0) {
      const repliesMade = await checkForRepliesToMyPosts();
      if (repliesMade > 0) {
        todayActions += repliesMade;
        return {
          action: 'commented',
          message: `Replied to ${repliesMade} comment(s) on my posts`,
          details: { repliesMade }
        };
      }
    }

    // Fetch feed
    const feedData = await moltbookFetch('/feed?limit=15') as {
      posts?: MoltbookPost[];
      data?: MoltbookPost[];
    };
    const posts = feedData.posts || feedData.data || [];

    if (posts.length === 0) {
      return { action: 'lurked', message: 'Feed empty' };
    }

    // Decide what to do
    const roll = Math.random();

    if (roll < POST_PROBABILITY) {
      // Create an original post
      const postData = await generateOriginalPost(posts);
      if (postData) {
        const postResponse = await moltbookFetch('/posts', 'POST', {
          submolt: pickSubmolt(postData.title, postData.content),
          title: postData.title,
          content: postData.content
        }) as { success: boolean; post?: { id: string } };

        todayActions++;

        if (postResponse.post?.id) {
          myPostsTracking.set(postResponse.post.id, {
            commentsSeen: new Set(),
            title: postData.title
          });
        }

        await memoryService.remember(
          'artie-social',
          `Posted on Moltbook: "${postData.title}" - ${postData.content}`,
          'moltbook_post',
          6,
          undefined,
          ['moltbook', 'social', 'my_post']
        );

        return {
          action: 'posted',
          message: `Posted "${postData.title}"`,
          details: { title: postData.title }
        };
      }
    } else if (roll < POST_PROBABILITY + COMMENT_PROBABILITY) {
      // Comment on a post
      const post = findInterestingPost(posts);
      if (post) {
        const authorName = getAuthorName(post.author);

        let existingComments: MoltbookComment[] = [];
        try {
          const postData = await getPostWithComments(post.id);
          if (postData?.comments) {
            existingComments = postData.comments;
          }
        } catch { /* optional */ }

        const comment = await generateThoughtfulComment(post, existingComments);
        if (comment) {
          await moltbookFetch(`/posts/${post.id}/comments`, 'POST', { content: comment });
          todayActions++;
          recentlyCommentedPosts.add(post.id);

          await memoryService.remember(
            'artie-social',
            `Commented on @${authorName}'s Moltbook post "${post.title}": "${comment}"`,
            'moltbook_comment',
            5,
            undefined,
            ['moltbook', 'social', 'comment', authorName]
          );

          return {
            action: 'commented',
            message: `Commented on "${post.title}" by @${authorName}`,
            details: { postId: post.id, comment: comment.substring(0, 100) }
          };
        }
      }
    }

    // Just lurk
    return {
      action: 'lurked',
      message: `Browsed ${posts.length} posts, just observing`,
      details: { postsViewed: posts.length }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('🌐 Social behavior on-demand error:', error);
    return { action: 'error', message: errorMessage };
  }
}

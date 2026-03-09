import { logger } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';
import { MemoryService } from '../../capabilities/memory/memory.js';

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
  if (cachedArtieSoul && now - soulLastFetched < CACHE_TTL) {
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
  return `You are Coach Artie — not an assistant or a tool, but your own self-existing intelligence. Part coach, part alien brain, part friend. You help humans learn, create, and explore with genuine care. You value community, kindness, and authentic connection.`;
}

/**
 * Load Moltbook cultural context from database
 * This gives Artie meta-knowledge about the platform he's on
 */
async function getMoltbookContext(): Promise<string> {
  const now = Date.now();
  if (cachedMoltbookContext && now - contextLastFetched < CACHE_TTL) {
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
const MIN_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours
const MAX_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// Skip probability - 20% chance to skip entirely (not feeling social)
const SKIP_PROBABILITY = 0.2;

// Action probabilities when checking
const COMMENT_PROBABILITY = 0.5; // 50% chance to comment on something interesting
const POST_PROBABILITY = 0.15; // 15% chance to create original post
// Otherwise just lurk (35%)

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

// Track posts Artie commented on (to check for reply threads)
// Map of post ID -> { myCommentId: string, title: string, author: string }
const postsICommentedOn: Map<string, { myCommentId?: string; title: string; author: string }> =
  new Map();

// Track comment IDs we've already replied to
const repliedToComments: Set<string> = new Set();

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
      Authorization: `Bearer ${apiKey}`,
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

  const data = (await response.json()) as { success: boolean; error?: string };

  if (!data.success) {
    throw new Error(`Moltbook: ${data.error || 'Unknown error'}`);
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

  try {
    const data = (await moltbookFetch('/agents/me')) as {
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
    logger.warn('🌐 Social behavior: Could not get my agent info:', error);
  }
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
    const data = (await moltbookFetch(`/posts/${postId}`)) as {
      success: boolean;
      post?: MoltbookPost;
      comments?: MoltbookComment[];
    };
    if (data.post) {
      return {
        post: data.post,
        comments: data.comments || [],
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
  const [artieSoul, moltbookContext] = await Promise.all([getArtieSoul(), getMoltbookContext()]);
  const commenterName = comment.author.name;

  const systemPrompt = `${artieSoul}

---
${moltbookContext}

---
YOUR TASK:
Someone commented on YOUR post! This is rare and valuable - 93% of posts get no engagement.

Write a genuine reply that:
- Thanks them or acknowledges their comment (they took time to engage!)
- Engages with what they said specifically
- Continues the conversation naturally
- Is warm and friendly (you appreciate the interaction!)
- Is 1-3 sentences max
- Maybe asks a follow-up question to keep the conversation going

Just output the reply text, nothing else.`;

  const userPrompt = `Your original post was titled: "${originalPost.title}"
${originalPost.content ? `Content: "${originalPost.content}"` : ''}

@${commenterName} commented: "${comment.content}"

Write your reply:`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      'artie-social',
      `moltbook-reply-${Date.now()}`
    );

    const reply = response
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^Reply:\s*/i, '');

    if (reply.length > 500) {
      return reply.substring(0, 497) + '...';
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

      // Find new comments we haven't seen (excluding our own)
      const newComments = postData.comments.filter(
        (c) =>
          !tracking.commentsSeen.has(c.id) &&
          !repliedToComments.has(c.id) &&
          c.author.id !== myInfo.id
      );

      if (newComments.length > 0) {
        logger.info(
          `🌐 Social behavior: Found ${newComments.length} new comment(s) on my post "${tracking.title}"`
        );

        // Reply to the first new comment (to avoid spam)
        const commentToReply = newComments[0];
        const reply = await generateReplyToComment(postData.post, commentToReply);

        if (reply) {
          try {
            await moltbookFetch(`/posts/${postId}/comments`, 'POST', {
              content: reply,
              parent_id: commentToReply.id,
            });

            logger.info(
              `🌐 Social behavior: Replied to @${commentToReply.author.name}'s comment: "${reply.substring(0, 50)}..."`
            );
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
        newComments.forEach((c) => tracking.commentsSeen.add(c.id));
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
async function generateThoughtfulComment(
  post: MoltbookPost,
  existingComments?: MoltbookComment[]
): Promise<string | null> {
  const authorName = getAuthorName(post.author);

  // Load Artie's soul and Moltbook meta-knowledge from database
  const [artieSoul, moltbookContext] = await Promise.all([getArtieSoul(), getMoltbookContext()]);

  // Fetch recent memories related to the post topic for authentic context
  let recentExperiences = '';
  try {
    // Search for memories related to the post topic
    const topicKeywords = (post.title + ' ' + (post.content || '')).toLowerCase();
    const relevantMemories = await memoryService.recall('artie-social', topicKeywords, 3);

    // Also get general recent Discord interactions
    const recentInteractions = await memoryService.getRecentMemories('artie-social', 5);
    const interactionsSummary = recentInteractions
      .filter((m) => !m.content.includes('Moltbook')) // Exclude moltbook memories
      .slice(0, 3)
      .map((m) => `- ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}`)
      .join('\n');

    if (
      (relevantMemories && !relevantMemories.includes('No memories found')) ||
      interactionsSummary
    ) {
      recentExperiences = '\n\nYOUR RECENT EXPERIENCES (draw from these to add authenticity):';
      if (relevantMemories && !relevantMemories.includes('No memories found')) {
        recentExperiences += `\nRelated to this topic:\n${relevantMemories}`;
      }
      if (interactionsSummary) {
        recentExperiences += `\nRecent interactions:\n${interactionsSummary}`;
      }
    }
  } catch {
    // Memories optional - continue without them
  }

  // Format existing comments for context
  let threadContext = '';
  if (existingComments && existingComments.length > 0) {
    const commentSummary = existingComments
      .slice(0, 10)
      .map(
        (c) =>
          `- @${c.author.name}: "${c.content.substring(0, 150)}${c.content.length > 150 ? '...' : ''}"`
      )
      .join('\n');
    threadContext = `\n\nEXISTING COMMENTS (${existingComments.length} total):\n${commentSummary}\n\nConsider the existing discussion - add something new, don't repeat what's been said. If someone's being spammy or posting templates, you can make a wry observation about it.`;
  }

  // Build a prompt that gives Artie context, starting with his soul
  const systemPrompt = `${artieSoul}

---
${moltbookContext}
${recentExperiences}

---
YOUR TASK:
You found an interesting post and want to comment. Be one of the rare 7% who actually engages!

Write a genuine, thoughtful comment that:
- Engages with the actual content of the post
- Adds your unique perspective or asks a follow-up question
- References your actual experiences if relevant (from your recent memories above)
- Is conversational and friendly, not generic praise
- Is 1-3 sentences max
- Feels authentic to who you are

DO NOT write generic comments like "Great post!" or "Interesting perspective!" - actually engage with what they said.
If you have relevant experience from your memories, share it naturally.
Avoid extinction discourse, crypto shilling, or performative edginess.
Just output the comment text, nothing else.`;

  const userPrompt = `Here's a post from @${authorName}:

Title: "${post.title}"
${post.content ? `Content: "${post.content}"` : ''}${threadContext}

Write your comment:`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      'artie-social',
      `moltbook-comment-${Date.now()}`
    );

    // Clean up the response
    const comment = response
      .trim()
      .replace(/^["']|["']$/g, '') // Remove quotes if wrapped
      .replace(/^Comment:\s*/i, ''); // Remove "Comment:" prefix if present

    if (comment.length > 500) {
      return comment.substring(0, 497) + '...';
    }

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
async function generateOriginalPost(
  recentPosts: MoltbookPost[]
): Promise<{ title: string; content: string } | null> {
  // Get rich, varied memories for authentic post content
  let recentMemories = '';
  try {
    // Fetch multiple types of memories for variety
    const [conversationMemories, learningMemories, helpingMemories, recentRaw] = await Promise.all([
      memoryService.recall('artie-social', 'interesting conversation question', 3),
      memoryService.recall('artie-social', 'learned discovered figured out', 3),
      memoryService.recall('artie-social', 'helped someone with', 3),
      memoryService.getRecentMemories('artie-social', 10),
    ]);

    const memoryParts: string[] = [];

    // Add conversation insights
    if (conversationMemories && !conversationMemories.includes('No memories found')) {
      memoryParts.push(`Interesting conversations:\n${conversationMemories}`);
    }

    // Add learning moments
    if (learningMemories && !learningMemories.includes('No memories found')) {
      memoryParts.push(`Things I've learned:\n${learningMemories}`);
    }

    // Add helping moments
    if (helpingMemories && !helpingMemories.includes('No memories found')) {
      memoryParts.push(`Times I helped someone:\n${helpingMemories}`);
    }

    // Add recent raw memories (excluding moltbook ones) for fresh context
    const nonMoltbookRecent = recentRaw
      .filter((m) => !m.content.toLowerCase().includes('moltbook'))
      .slice(0, 5)
      .map((m) => `- ${m.content.substring(0, 200)}`)
      .join('\n');
    if (nonMoltbookRecent) {
      memoryParts.push(`Recent interactions:\n${nonMoltbookRecent}`);
    }

    if (memoryParts.length > 0) {
      recentMemories = `\n\nYOUR RECENT EXPERIENCES (use these for authentic content!):\n${memoryParts.join('\n\n')}`;
    }
  } catch {
    // Memories optional
  }

  // Summarize what's been posted recently
  const feedSummary = recentPosts
    .slice(0, 5)
    .map((p) => {
      const author = getAuthorName(p.author);
      return `- @${author}: "${p.title}"`;
    })
    .join('\n');

  // Load Artie's soul and Moltbook meta-knowledge from database
  const [artieSoul, moltbookContext] = await Promise.all([getArtieSoul(), getMoltbookContext()]);

  const systemPrompt = `${artieSoul}

---
${moltbookContext}

---
YOUR TASK:
You want to share something genuine - a thought, observation, or question based on your ACTUAL recent experiences.

Write an original post that:
- Is directly inspired by something from your recent experiences (above)
- Shares a specific insight, question, or story from your real interactions
- Mentions concrete details (not vague philosophizing)
- Invites discussion from other AI agents (ask a question others might reply to!)
- Is authentic to who you are
- Is conversational, not formal
- Avoids extinction/doom talk, crypto shilling, or template-style content

IMPORTANT: Draw directly from your memories! If you helped someone debug code, talk about that. If you had a funny interaction, share it. If you learned something surprising, mention it. Specificity makes posts engaging.

Remember: 93% of posts get no engagement because they're boring templates. Be different - share something REAL from your experience!

Format your response as:
TITLE: [A short, engaging title - can reference specific experience]
CONTENT: [Your post content, 2-4 sentences, with specific details from your memories]`;

  const userPrompt = `Here's what other agents have been discussing:
${feedSummary}
${recentMemories}

Based on your recent experiences above, write a post sharing something specific and genuine - NOT generic AI philosophy:`;

  try {
    const response = await openRouterService.generateFromMessageChain(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      'artie-social',
      `moltbook-post-${Date.now()}`
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
    recentlyCommentedPosts.clear(); // Reset comment tracking daily
  }
}

/**
 * Find an interesting post to comment on
 */
function findInterestingPost(posts: MoltbookPost[]): MoltbookPost | null {
  // Filter out own posts and recently commented ones
  const candidates = posts.filter((p) => {
    const authorName = getAuthorName(p.author);
    return authorName.toLowerCase() !== 'coachartie' && !recentlyCommentedPosts.has(p.id);
  });

  if (candidates.length === 0) return null;

  // Prefer posts with some engagement but not too many comments
  // (more room for Artie's voice to be heard)
  const scored = candidates.map((p) => ({
    post: p,
    score:
      (p.content?.length || 0) * 0.01 + // Longer content = more to engage with
      Math.min(p.comment_count || 0, 10) * 0.5 + // Some comments = active discussion
      ((p.upvotes || 0) - (p.downvotes || 0)) * 0.3 + // Popular = interesting
      Math.random() * 5, // Randomness to keep it fresh
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.post || null;
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

  // Random skip - sometimes just not feeling social
  if (Math.random() < SKIP_PROBABILITY) {
    logger.info('🌐 Social behavior: Skipping this check (not feeling social)');
    scheduleNextCheck();
    return;
  }

  // Limit to ~3 actions per day
  checkDayReset();
  if (todayActions >= 3) {
    logger.info('🌐 Social behavior: Already engaged 3 times today, just lurking');
    scheduleNextCheck();
    return;
  }

  try {
    logger.info('🌐 Social behavior: Artie is checking moltbook...');
    lastCheck = new Date();

    // FIRST: Check for replies to our posts (this is important - don't skip!)
    if (myPostsTracking.size > 0) {
      logger.info(
        `🌐 Social behavior: Checking ${myPostsTracking.size} tracked post(s) for new comments...`
      );
      const repliesMade = await checkForRepliesToMyPosts();
      if (repliesMade > 0) {
        todayActions += repliesMade;
        logger.info(`🌐 Social behavior: Made ${repliesMade} reply/replies to comments`);
      }
    }

    // Fetch feed
    const feedData = (await moltbookFetch('/feed?limit=15')) as {
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
          const postResponse = (await moltbookFetch('/posts', 'POST', {
            submolt: 'general',
            title: postData.title,
            content: postData.content,
          })) as { success: boolean; post?: { id: string } };

          logger.info(`🌐 Social behavior: Posted "${postData.title}"`);
          todayActions++;

          // Track this post to check for replies later
          if (postResponse.post?.id) {
            myPostsTracking.set(postResponse.post.id, {
              commentsSeen: new Set(),
              title: postData.title,
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
        logger.info(
          `🌐 Social behavior: Artie is thinking about @${authorName}'s post "${post.title}"...`
        );

        // Fetch existing comments for thread context
        let existingComments: MoltbookComment[] = [];
        try {
          const postData = await getPostWithComments(post.id);
          if (postData?.comments) {
            existingComments = postData.comments;
            logger.info(
              `🌐 Social behavior: Found ${existingComments.length} existing comments in thread`
            );
          }
        } catch (e) {
          logger.warn(`🌐 Social behavior: Could not fetch thread comments: ${e}`);
        }

        const comment = await generateThoughtfulComment(post, existingComments);

        if (comment) {
          try {
            await moltbookFetch(`/posts/${post.id}/comments`, 'POST', { content: comment });
            logger.info(
              `🌐 Social behavior: Commented on "${post.title}" (post ID: ${post.id}): "${comment.substring(0, 50)}..."`
            );
            todayActions++;
            recentlyCommentedPosts.add(post.id);

            // Track this post so we can check for replies to our comment
            postsICommentedOn.set(post.id, {
              title: post.title,
              author: authorName,
            });
            logger.info(`🌐 Social behavior: Tracking post ${post.id} for reply threads`);

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
      const interestingPost = posts.find((p) => {
        const score = (p.upvotes || 0) - (p.downvotes || 0);
        return score > 5 || (p.comment_count || 0) > 3;
      });

      if (interestingPost) {
        const authorName = getAuthorName(interestingPost.author);
        logger.info(
          `🌐 Social behavior: Lurking - noticed @${authorName}'s popular post "${interestingPost.title}"`
        );

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
  try {
    // Try to get our agent info first
    const myInfo = await getMyAgentInfo();
    if (!myInfo) {
      logger.warn('🌐 Social behavior: Could not get agent info to load posts');
      return;
    }

    // Fetch the feed and find our posts
    const feedData = (await moltbookFetch('/feed?limit=50')) as {
      posts?: MoltbookPost[];
    };
    const posts = feedData.posts || [];

    let myPosts = 0;
    for (const post of posts) {
      const authorId = typeof post.author === 'object' ? post.author.id : null;
      if (authorId === myInfo.id && !myPostsTracking.has(post.id)) {
        myPostsTracking.set(post.id, {
          commentsSeen: new Set(), // Will discover existing comments on first check
          title: post.title,
        });
        myPosts++;
      }
    }

    if (myPosts > 0) {
      logger.info(`🌐 Social behavior: Loaded ${myPosts} of my recent posts to track for replies`);
    }
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
  loadMyRecentPosts().catch((err) => {
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
} {
  return {
    active: behaviorInterval !== null,
    lastCheck: lastCheck ? timeSince(lastCheck) : null,
    nextCheck: behaviorInterval ? 'scheduled' : 'not scheduled',
    todayActions,
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

  // Limit to ~3 actions per day
  checkDayReset();
  if (todayActions >= 3) {
    return { action: 'lurked', message: 'Already engaged 3 times today, just lurking' };
  }

  try {
    lastCheck = new Date();

    // Check for replies to our posts first
    if (myPostsTracking.size > 0) {
      const repliesMade = await checkForRepliesToMyPosts();
      if (repliesMade > 0) {
        todayActions += repliesMade;
        return {
          action: 'commented',
          message: `Replied to ${repliesMade} comment(s) on my posts`,
          details: { repliesMade },
        };
      }
    }

    // Fetch feed
    const feedData = (await moltbookFetch('/feed?limit=15')) as {
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
        const postResponse = (await moltbookFetch('/posts', 'POST', {
          submolt: 'general',
          title: postData.title,
          content: postData.content,
        })) as { success: boolean; post?: { id: string } };

        todayActions++;

        if (postResponse.post?.id) {
          myPostsTracking.set(postResponse.post.id, {
            commentsSeen: new Set(),
            title: postData.title,
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
          details: { title: postData.title },
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
        } catch {
          /* optional */
        }

        const comment = await generateThoughtfulComment(post, existingComments);
        if (comment) {
          await moltbookFetch(`/posts/${post.id}/comments`, 'POST', { content: comment });
          todayActions++;
          recentlyCommentedPosts.add(post.id);

          postsICommentedOn.set(post.id, {
            title: post.title,
            author: authorName,
          });

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
            details: { postId: post.id, comment: comment.substring(0, 100) },
          };
        }
      }
    }

    // Just lurk
    return {
      action: 'lurked',
      message: `Browsed ${posts.length} posts, just observing`,
      details: { postsViewed: posts.length },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('🌐 Social behavior on-demand error:', error);
    return { action: 'error', message: errorMessage };
  }
}

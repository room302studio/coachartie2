import axios, { AxiosInstance } from 'axios';
import { logger } from '@coachartie/shared';

const REDDIT_OAUTH_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API_BASE = 'https://oauth.reddit.com';

type RedditSort = 'hot' | 'new' | 'top' | 'rising';
type RedditTime = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditPostSummary {
  id: string;
  title: string;
  author: string;
  score: number;
  comments: number;
  createdUtc: number;
  permalink: string;
  url?: string;
  selftext?: string;
}

export interface RedditReadOptions {
  subreddit: string;
  sort?: RedditSort;
  time?: RedditTime;
  limit?: number;
}

export interface RedditSearchOptions extends RedditReadOptions {
  query: string;
}

export interface RedditSubmitOptions {
  subreddit: string;
  title: string;
  text?: string;
  url?: string;
  flairId?: string;
}

export interface RedditCommentOptions {
  thingId?: string;
  postId?: string;
  permalink?: string;
  text: string;
}

export interface RedditMention {
  name: string;
  author: string;
  subreddit?: string;
  body?: string;
  context?: string;
  createdUtc?: number;
  linkTitle?: string;
  linkPermalink?: string;
  isNew: boolean;
}

function parseAllowedSubreddits(raw?: string | null): string[] {
  if (!raw) return [];

  return raw
    .split(',')
    .map((s) => s.trim().replace(/^r\//i, '').toLowerCase())
    .filter(Boolean);
}

export class RedditClient {
  private accessToken?: string;
  private tokenExpiresAt?: number;
  private httpClient?: AxiosInstance;

  private get config() {
    return {
      clientId: process.env.REDDIT_CLIENT_ID,
      clientSecret: process.env.REDDIT_CLIENT_SECRET,
      username: process.env.REDDIT_USERNAME,
      password: process.env.REDDIT_PASSWORD,
      userAgent: process.env.REDDIT_USER_AGENT || 'CoachArtieBot/1.0 (by /u/coachartie)',
      allowedSubreddits: parseAllowedSubreddits(process.env.REDDIT_ALLOWED_SUBS),
    };
  }

  private get scopes(): string {
    const raw = process.env.REDDIT_SCOPES;
    if (raw) {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
    }

    // Default scopes cover identity + read inbox + submit + mark read (privatemessages) per Reddit docs
    return 'identity read submit privatemessages';
  }

  isConfigured(): boolean {
    const { clientId, clientSecret, username, password } = this.config;
    return Boolean(clientId && clientSecret && username && password);
  }

  getMissingConfig(): string[] {
    const missing = [];
    const { clientId, clientSecret, username, password } = this.config;
    if (!clientId) missing.push('REDDIT_CLIENT_ID');
    if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
    if (!username) missing.push('REDDIT_USERNAME');
    if (!password) missing.push('REDDIT_PASSWORD');
    return missing;
  }

  getAllowedSubreddits() {
    const allowed = this.config.allowedSubreddits;
    return {
      mode: allowed.length > 0 ? 'allowlist' : 'open',
      allowedSubreddits: allowed,
    };
  }

  getBotUsername(): string | undefined {
    return this.config.username;
  }

  private normalizeSubreddit(subreddit?: string): string {
    if (!subreddit) return '';
    return subreddit.replace(/^r\//i, '').toLowerCase();
  }

  private ensureSubredditAllowed(subreddit?: string): string {
    const normalized = this.normalizeSubreddit(subreddit);
    const { allowedSubreddits } = this.config;

    if (!normalized) {
      throw new Error('Subreddit is required (e.g. subreddit="coachartie")');
    }

    if (allowedSubreddits.length > 0 && !allowedSubreddits.includes(normalized)) {
      throw new Error(
        `Subreddit r/${normalized} is not in the allowlist. Allowed: ${allowedSubreddits.join(', ')}`
      );
    }

    return normalized;
  }

  private async ensureHttpClient(): Promise<AxiosInstance> {
    if (this.httpClient && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt) {
      return this.httpClient;
    }

    const token = await this.fetchAccessToken();
    this.tokenExpiresAt = Date.now() + (token.expiresIn - 60) * 1000;

    this.httpClient = axios.create({
      baseURL: REDDIT_API_BASE,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'User-Agent': this.config.userAgent,
      },
    });

    return this.httpClient;
  }

  private async fetchAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    if (!this.isConfigured()) {
      const missing = this.getMissingConfig();
      throw new Error(`Reddit credentials missing: ${missing.join(', ')}`);
    }

    const { clientId, clientSecret, username, password, userAgent } = this.config;
    const body = new URLSearchParams({
      grant_type: 'password',
      username: username as string,
      password: password as string,
      scope: this.scopes,
    });

    try {
      const response = await axios.post(REDDIT_OAUTH_URL, body, {
        auth: {
          username: clientId as string,
          password: clientSecret as string,
        },
        headers: {
          'User-Agent': userAgent,
        },
      });

      const accessToken = response.data.access_token as string;
      const expiresIn = response.data.expires_in as number;

      if (!accessToken) {
        throw new Error('Missing access_token in Reddit response');
      }

      logger.info('✅ Obtained Reddit access token');
      this.accessToken = accessToken;

      return { accessToken, expiresIn: expiresIn || 3600 };
    } catch (error) {
      logger.error('❌ Failed to obtain Reddit token:', error);
      throw new Error('Reddit authentication failed. Check credentials and scopes.');
    }
  }

  async fetchSubredditPosts(options: RedditReadOptions): Promise<{
    success: boolean;
    subreddit: string;
    posts: RedditPostSummary[];
  }> {
    const subreddit = this.ensureSubredditAllowed(options.subreddit);
    const sort: RedditSort = (options.sort as RedditSort) || 'hot';
    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const time: RedditTime | undefined = options.time as RedditTime;

    const client = await this.ensureHttpClient();
    const params: Record<string, string | number> = { limit };
    if (sort === 'top' && time) {
      params.t = time;
    }

    try {
      const response = await client.get(`/r/${subreddit}/${sort}.json`, { params });
      const posts: RedditPostSummary[] =
        response.data?.data?.children?.map((child: any) => {
          const data = child.data;
          return {
            id: data.id,
            title: data.title,
            author: data.author,
            score: data.score,
            comments: data.num_comments,
            createdUtc: data.created_utc,
            permalink: `https://reddit.com${data.permalink}`,
            url: data.url,
            selftext: data.selftext,
          } as RedditPostSummary;
        }) || [];

      return { success: true, subreddit, posts };
    } catch (error) {
      logger.error(`❌ Failed to fetch posts for r/${subreddit}:`, error);
      throw new Error(`Unable to fetch posts for r/${subreddit}.`);
    }
  }

  async searchSubreddit(options: RedditSearchOptions): Promise<{
    success: boolean;
    subreddit: string;
    query: string;
    posts: RedditPostSummary[];
  }> {
    const subreddit = this.ensureSubredditAllowed(options.subreddit);
    const query = options.query;
    if (!query) {
      throw new Error('Search query is required.');
    }

    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50);
    const client = await this.ensureHttpClient();

    try {
      const response = await client.get(`/r/${subreddit}/search.json`, {
        params: {
          q: query,
          restrict_sr: 1,
          limit,
        },
      });

      const posts: RedditPostSummary[] =
        response.data?.data?.children?.map((child: any) => {
          const data = child.data;
          return {
            id: data.id,
            title: data.title,
            author: data.author,
            score: data.score,
            comments: data.num_comments,
            createdUtc: data.created_utc,
            permalink: `https://reddit.com${data.permalink}`,
            url: data.url,
            selftext: data.selftext,
          } as RedditPostSummary;
        }) || [];

      return { success: true, subreddit, query, posts };
    } catch (error) {
      logger.error(`❌ Reddit search failed for r/${subreddit}:`, error);
      throw new Error(`Unable to search r/${subreddit} for "${query}".`);
    }
  }

  async submitPost(options: RedditSubmitOptions): Promise<{
    success: boolean;
    subreddit: string;
    id?: string;
    url?: string;
    permalink?: string;
    message?: string;
  }> {
    const subreddit = this.ensureSubredditAllowed(options.subreddit);
    if (!options.title) {
      throw new Error('Title is required to submit a Reddit post.');
    }

    if (!options.text && !options.url) {
      throw new Error('Provide either text content or a URL for the post.');
    }

    const client = await this.ensureHttpClient();
    const kind = options.url ? 'link' : 'self';

    try {
      const response = await client.post(
        '/api/submit',
        new URLSearchParams({
          sr: subreddit,
          kind,
          title: options.title,
          text: options.text || '',
          url: options.url || '',
          flair_id: options.flairId || '',
          api_type: 'json',
        })
      );

      const json = response.data?.json;
      const postId = json?.data?.id;
      const permalink = json?.data?.url || (postId ? `https://reddit.com/comments/${postId}` : undefined);

      if (json?.errors?.length) {
        throw new Error(json.errors.map((e: any) => e.join(': ')).join('; '));
      }

      return {
        success: true,
        subreddit,
        id: postId,
        url: options.url,
        permalink,
        message: 'Post submitted to Reddit',
      };
    } catch (error) {
      logger.error(`❌ Failed to submit post to r/${subreddit}:`, error);
      throw new Error(`Unable to submit post to r/${subreddit}.`);
    }
  }

  async addComment(options: RedditCommentOptions): Promise<{
    success: boolean;
    thingId?: string;
    permalink?: string;
    message?: string;
  }> {
    const text = options.text;
    if (!text) {
      throw new Error('Comment text is required.');
    }

    const thingId = await this.resolveThingId(options);
    const client = await this.ensureHttpClient();

    try {
      const response = await client.post(
        '/api/comment',
        new URLSearchParams({
          thing_id: thingId,
          text,
          api_type: 'json',
        })
      );

      const data = response.data?.json?.data;
      if (response.data?.json?.errors?.length) {
        throw new Error(response.data.json.errors.map((e: any) => e.join(': ')).join('; '));
      }

      return {
        success: true,
        thingId,
        permalink: data?.things?.[0]?.data?.permalink
          ? `https://reddit.com${data.things[0].data.permalink}`
          : undefined,
        message: 'Comment posted to Reddit',
      };
    } catch (error) {
      logger.error('❌ Failed to post Reddit comment:', error);
      throw new Error('Unable to post comment. Check thing_id or Reddit status.');
    }
  }

  private async resolveThingId(options: RedditCommentOptions): Promise<string> {
    if (options.thingId) {
      return this.normalizeThingId(options.thingId);
    }

    if (options.postId) {
      return this.normalizeThingId(options.postId, 't3');
    }

    if (options.permalink) {
      const client = await this.ensureHttpClient();
      try {
        const response = await client.get(`${options.permalink.replace(/^https?:\/\/[^/]+/, '')}.json`);
        const postId = response.data?.[0]?.data?.children?.[0]?.data?.id;
        if (!postId) throw new Error('Unable to resolve permalink to a Reddit thing id');
        return this.normalizeThingId(postId, 't3');
      } catch (error) {
        logger.error('❌ Failed to resolve permalink to thing_id:', error);
        throw new Error('Could not resolve permalink to a Reddit post/comment id.');
      }
    }

    throw new Error('Provide a thing_id, post_id, or permalink to comment on.');
  }

  private normalizeThingId(id: string, prefix: 't1' | 't3' = 't3'): string {
    if (id.startsWith('t1_') || id.startsWith('t3_')) {
      return id;
    }
    return `${prefix}_${id}`;
  }

  async fetchMentions(limit = 50): Promise<{
    success: boolean;
    mentions: RedditMention[];
  }> {
    const client = await this.ensureHttpClient();
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

    try {
      const response = await client.get('/message/unread.json', {
        params: {
          limit: safeLimit,
          mark: false, // do not auto-mark as read; we will mark after queueing
        },
      });

      const children = response.data?.data?.children || [];
      const mentions: RedditMention[] = children
        .map((child: any) => child?.data)
        .filter((data: any) => data?.type === 'username_mention')
        .map((data: any) => ({
          name: data.name,
          author: data.author,
          subreddit: data.subreddit,
          body: data.body,
          context: data.context,
          createdUtc: data.created_utc,
          linkTitle: data.link_title,
          linkPermalink: data.link_permalink,
          isNew: !!data.new,
        }));

      return { success: true, mentions };
    } catch (error) {
      logger.error('❌ Failed to fetch Reddit mentions:', error);
      throw new Error('Unable to fetch Reddit mentions (inbox).');
    }
  }

  async markMessagesRead(fullnames: string[]): Promise<void> {
    if (!fullnames.length) return;
    const client = await this.ensureHttpClient();

    try {
      await client.post(
        '/api/read_message',
        new URLSearchParams({
          id: fullnames.join(','),
        })
      );
      logger.info(`✅ Marked ${fullnames.length} Reddit mention(s) as read`);
    } catch (error) {
      logger.error('❌ Failed to mark Reddit messages as read:', error);
      // Do not throw to avoid blocking processing; warn only
    }
  }
}

export const redditClient = new RedditClient();

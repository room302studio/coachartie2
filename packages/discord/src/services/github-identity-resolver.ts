/**
 * GitHub Identity Auto-Resolver
 *
 * Automatically maps GitHub usernames to Discord users by:
 * 1. Exact username match (confidence: 1.0)
 * 2. Display name match (confidence: 0.8)
 * 3. Fuzzy username match (confidence: 0.6)
 * 4. Contextual learning from chat (confidence: 0.7)
 *
 * Runs on startup and periodically to keep mappings fresh.
 */

import { Client, GuildMember } from 'discord.js';
import { Octokit } from '@octokit/rest';
import {
  logger,
  getDb,
  githubIdentityMappings,
  githubRepoWatches,
  eq,
} from '@coachartie/shared';

interface DiscordMemberInfo {
  id: string;
  username: string;
  displayName: string;
  globalName: string | null;
  nickname: string | null;
}

interface IdentityMatch {
  githubUsername: string;
  discordUserId: string;
  displayName: string;
  confidence: number;
  source: string;
}

export class GitHubIdentityResolver {
  private client: Client;
  private octokit: Octokit;
  private resolveInterval: NodeJS.Timeout | null = null;

  constructor(client: Client, githubToken: string) {
    this.client = client;
    this.octokit = new Octokit({ auth: githubToken });
  }

  /**
   * Start periodic resolution (runs every 6 hours)
   */
  start(): void {
    // Run immediately on startup
    this.resolveAll().catch((err) =>
      logger.error('Identity resolver initial run failed:', err)
    );

    // Then every 6 hours
    this.resolveInterval = setInterval(
      () => this.resolveAll().catch((err) =>
        logger.error('Identity resolver periodic run failed:', err)
      ),
      6 * 60 * 60 * 1000
    );

    logger.info('GitHub identity resolver started');
  }

  stop(): void {
    if (this.resolveInterval) {
      clearInterval(this.resolveInterval);
      this.resolveInterval = null;
    }
  }

  /**
   * Run full resolution across all watched repos
   */
  async resolveAll(): Promise<void> {
    const db = getDb();

    // Get all watched repos
    const watches = await db.select().from(githubRepoWatches);
    if (watches.length === 0) return;

    // Collect GitHub contributors from all watched repos
    const githubUsers = new Map<string, string>(); // username -> display name
    for (const watch of watches) {
      const [owner, repo] = watch.repo.split('/');
      if (!owner || !repo) continue;

      try {
        const { data: contributors } = await this.octokit.repos.listContributors({
          owner,
          repo,
          per_page: 50,
        });

        for (const contributor of contributors) {
          if (!contributor.login || contributor.type === 'Bot') continue;
          githubUsers.set(contributor.login.toLowerCase(), contributor.login);
        }
      } catch (err) {
        logger.debug(`Failed to fetch contributors for ${watch.repo}:`, err);
      }
    }

    if (githubUsers.size === 0) return;

    // Collect Discord members from guilds that have repo watches
    const guildIds = new Set(watches.map((w) => w.guildId));
    const discordMembers: DiscordMemberInfo[] = [];

    for (const guildId of guildIds) {
      try {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) continue;

        // Fetch all members (may need privileged intent)
        const members = await guild.members.fetch();
        for (const [, member] of members) {
          if (member.user.bot) continue;
          discordMembers.push({
            id: member.id,
            username: member.user.username.toLowerCase(),
            displayName: member.displayName.toLowerCase(),
            globalName: member.user.globalName?.toLowerCase() || null,
            nickname: member.nickname?.toLowerCase() || null,
          });
        }
      } catch (err) {
        logger.debug(`Failed to fetch guild members for ${guildId}:`, err);
      }
    }

    if (discordMembers.length === 0) return;

    // Match GitHub users to Discord members
    const matches: IdentityMatch[] = [];

    for (const [ghLower, ghOriginal] of githubUsers) {
      // Skip if we already have a high-confidence mapping
      const existing = await db
        .select()
        .from(githubIdentityMappings)
        .where(eq(githubIdentityMappings.githubUsername, ghLower))
        .limit(1);

      if (existing[0] && (existing[0].confidence || 0) >= 0.9) continue;

      const match = this.findBestMatch(ghLower, ghOriginal, discordMembers);
      if (match) {
        matches.push(match);
      }
    }

    // Upsert matches (only upgrade confidence, never downgrade)
    for (const match of matches) {
      const existing = await db
        .select()
        .from(githubIdentityMappings)
        .where(eq(githubIdentityMappings.githubUsername, match.githubUsername.toLowerCase()))
        .limit(1);

      if (existing[0]) {
        // Only update if new confidence is higher
        if (match.confidence > (existing[0].confidence || 0)) {
          await db
            .update(githubIdentityMappings)
            .set({
              discordUserId: match.discordUserId,
              displayName: match.displayName,
              confidence: match.confidence,
              source: match.source,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(githubIdentityMappings.githubUsername, match.githubUsername.toLowerCase()));

          logger.info(
            `Updated identity: ${match.githubUsername} → Discord ${match.discordUserId} (${match.confidence}, ${match.source})`
          );
        }
      } else {
        await db.insert(githubIdentityMappings).values({
          githubUsername: match.githubUsername.toLowerCase(),
          discordUserId: match.discordUserId,
          displayName: match.displayName,
          confidence: match.confidence,
          source: match.source,
        });

        logger.info(
          `New identity: ${match.githubUsername} → Discord ${match.discordUserId} (${match.confidence}, ${match.source})`
        );
      }
    }

    const msg = `Identity resolver: ${githubUsers.size} GitHub users, ${discordMembers.length} Discord members, ${matches.length} new/updated matches`;
    logger.info(msg);
    console.log(`🔗 ${msg}`);
  }

  /**
   * Find the best Discord member match for a GitHub username
   */
  private findBestMatch(
    ghLower: string,
    ghOriginal: string,
    members: DiscordMemberInfo[]
  ): IdentityMatch | null {
    let bestMatch: IdentityMatch | null = null;

    for (const member of members) {
      let confidence = 0;
      let source = '';

      // 1. Exact username match (highest confidence)
      if (member.username === ghLower) {
        confidence = 1.0;
        source = 'exact_username';
      }
      // 2. Global name exact match
      else if (member.globalName === ghLower) {
        confidence = 0.9;
        source = 'exact_globalname';
      }
      // 3. Nickname exact match
      else if (member.nickname === ghLower) {
        confidence = 0.85;
        source = 'exact_nickname';
      }
      // 4. Display name exact match
      else if (member.displayName === ghLower) {
        confidence = 0.8;
        source = 'exact_displayname';
      }
      // 5. Username contains GitHub name (or vice versa), min 4 chars
      else if (ghLower.length >= 4 && member.username.includes(ghLower)) {
        confidence = 0.6;
        source = 'username_contains';
      } else if (member.username.length >= 4 && ghLower.includes(member.username)) {
        confidence = 0.6;
        source = 'github_contains';
      }
      // 6. Fuzzy: Levenshtein distance ≤ 2 for usernames ≥ 5 chars
      else if (ghLower.length >= 5 && member.username.length >= 5) {
        const dist = this.levenshtein(ghLower, member.username);
        if (dist <= 2) {
          confidence = 0.5;
          source = `fuzzy_levenshtein_${dist}`;
        }
      }

      if (confidence > 0 && (!bestMatch || confidence > bestMatch.confidence)) {
        bestMatch = {
          githubUsername: ghOriginal,
          discordUserId: member.id,
          displayName: member.displayName || member.username,
          confidence,
          source,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Learn from chat context — e.g., someone says "I just pushed" or "my PR"
   * Called from message handlers when someone talks about GitHub activity.
   *
   * Strategy:
   * 1. Explicit: "I'm colindm on GitHub" → direct mapping
   * 2. Temporal correlation: "just pushed my fix" + recent commit by unknown user → infer
   * 3. PR/issue reference: "my PR #477" + PR #477 author known → map
   */
  async learnFromContext(
    discordUserId: string,
    discordUsername: string,
    messageText: string
  ): Promise<void> {
    // 1. Check for explicit self-identification
    const explicitMatch = messageText.match(/(?:my github|i'm|im|i am) (\w+) on github/i);
    if (explicitMatch) {
      const ghUsername = explicitMatch[1].toLowerCase();
      const db = getDb();

      // Check if mapping exists
      const existing = await db
        .select()
        .from(githubIdentityMappings)
        .where(eq(githubIdentityMappings.githubUsername, ghUsername))
        .limit(1);

      if (existing[0]) {
        await db
          .update(githubIdentityMappings)
          .set({
            discordUserId,
            displayName: discordUsername,
            confidence: 0.95,
            source: 'self_identified',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(githubIdentityMappings.githubUsername, ghUsername));
      } else {
        await db.insert(githubIdentityMappings).values({
          githubUsername: ghUsername,
          discordUserId,
          displayName: discordUsername,
          confidence: 0.95,
          source: 'self_identified',
        });
      }

      logger.info(`Identity learned from chat: ${ghUsername} → ${discordUsername} (self-identified)`);
      console.log(`🔗 Identity learned: ${ghUsername} → ${discordUsername} (self-identified)`);
      return;
    }

    // 2. PR/issue reference: "my PR #477" or "I opened #481"
    const prRefMatch = messageText.match(/(?:my|i (?:just )?(?:opened|created|filed|submitted|pushed)) (?:pr|pull request|issue)?\s*#?(\d+)/i);
    if (prRefMatch) {
      const number = parseInt(prRefMatch[1]);
      await this.correlateFromPrOrIssue(discordUserId, discordUsername, number);
      return;
    }

    // 3. Temporal correlation: "just pushed" / "just committed" → check recent commits
    const pushMatch = messageText.match(/(?:i (?:just )?(?:pushed|committed|merged|deployed)|just pushed|just merged)/i);
    if (pushMatch) {
      await this.correlateFromRecentActivity(discordUserId, discordUsername);
    }
  }

  /**
   * Correlate a Discord user with a GitHub user by PR/issue number
   */
  private async correlateFromPrOrIssue(
    discordUserId: string,
    discordUsername: string,
    number: number
  ): Promise<void> {
    const db = getDb();
    const watches = await db.select().from(githubRepoWatches);

    for (const watch of watches) {
      const [owner, repo] = watch.repo.split('/');
      if (!owner || !repo) continue;

      try {
        // Try as PR first
        const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: number }).catch(() => ({ data: null }));
        if (pr?.user?.login) {
          await this.saveCorrelation(pr.user.login, discordUserId, discordUsername, 0.8, 'pr_reference');
          return;
        }

        // Try as issue
        const { data: issue } = await this.octokit.issues.get({ owner, repo, issue_number: number }).catch(() => ({ data: null }));
        if (issue?.user?.login) {
          await this.saveCorrelation(issue.user.login, discordUserId, discordUsername, 0.75, 'issue_reference');
          return;
        }
      } catch {
        // API error, skip this repo
      }
    }
  }

  /**
   * Correlate a Discord user with whoever recently pushed to a watched repo
   */
  private async correlateFromRecentActivity(
    discordUserId: string,
    discordUsername: string
  ): Promise<void> {
    const db = getDb();
    const watches = await db.select().from(githubRepoWatches);

    for (const watch of watches) {
      const [owner, repo] = watch.repo.split('/');
      if (!owner || !repo) continue;

      try {
        // Check commits in last 10 minutes
        const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data: commits } = await this.octokit.repos.listCommits({
          owner,
          repo,
          since,
          per_page: 5,
        });

        // If exactly one non-bot author pushed recently, that's probably them
        const authors = new Set(
          commits
            .filter((c) => c.author?.login && !c.author.login.includes('[bot]'))
            .map((c) => c.author!.login!)
        );

        if (authors.size === 1) {
          const ghUser = [...authors][0];
          // Only correlate if we don't already have a high-confidence mapping for this GitHub user
          const existing = await db
            .select()
            .from(githubIdentityMappings)
            .where(eq(githubIdentityMappings.githubUsername, ghUser.toLowerCase()))
            .limit(1);

          if (!existing[0] || (existing[0].confidence || 0) < 0.7) {
            await this.saveCorrelation(ghUser, discordUserId, discordUsername, 0.7, 'temporal_push');
          }
        }
      } catch {
        // API error, skip
      }
    }
  }

  /**
   * Save a correlation (only upgrade confidence, never downgrade)
   */
  private async saveCorrelation(
    githubUsername: string,
    discordUserId: string,
    discordDisplayName: string,
    confidence: number,
    source: string
  ): Promise<void> {
    const db = getDb();
    const ghLower = githubUsername.toLowerCase();

    const existing = await db
      .select()
      .from(githubIdentityMappings)
      .where(eq(githubIdentityMappings.githubUsername, ghLower))
      .limit(1);

    if (existing[0]) {
      if (confidence > (existing[0].confidence || 0)) {
        await db
          .update(githubIdentityMappings)
          .set({
            discordUserId,
            displayName: discordDisplayName,
            confidence,
            source,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(githubIdentityMappings.githubUsername, ghLower));

        logger.info(`Identity updated: ${githubUsername} → ${discordDisplayName} (${confidence}, ${source})`);
        console.log(`🔗 Identity updated: ${githubUsername} → ${discordDisplayName} (${confidence}, ${source})`);
      }
    } else {
      await db.insert(githubIdentityMappings).values({
        githubUsername: ghLower,
        discordUserId,
        displayName: discordDisplayName,
        confidence,
        source,
      });

      logger.info(`Identity learned: ${githubUsername} → ${discordDisplayName} (${confidence}, ${source})`);
      console.log(`🔗 Identity learned: ${githubUsername} → ${discordDisplayName} (${confidence}, ${source})`);
    }
  }

  /**
   * Levenshtein distance for fuzzy matching
   */
  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
}

// Singleton
let resolver: GitHubIdentityResolver | null = null;

export function initializeIdentityResolver(client: Client): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  resolver = new GitHubIdentityResolver(client, token);
  resolver.start();
}

export function getIdentityResolver(): GitHubIdentityResolver | null {
  return resolver;
}

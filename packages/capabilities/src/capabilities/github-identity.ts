import { logger, getDb, githubIdentityMappings, type GithubIdentityMapping } from '@coachartie/shared';
import { eq } from 'drizzle-orm';
import { RegisteredCapability } from '../services/capability/capability-registry.js';

/**
 * GitHub Identity capability - Artie can manage GitHub ↔ Discord user mappings
 *
 * Lets Artie:
 * - Query existing mappings
 * - Learn new mappings (from observation or explicit info)
 * - Update mappings with new confidence levels
 * - Suggest mappings based on heuristics (matching names)
 */

interface GithubIdentityParams {
  action: 'query' | 'learn' | 'list' | 'forget' | 'suggest';
  githubUsername?: string;
  discordUserId?: string;
  discordUsername?: string;
  confidence?: number;
  source?: 'manual' | 'learned' | 'heuristic';
}

/**
 * Query a GitHub → Discord mapping
 */
async function queryMapping(githubUsername: string): Promise<string> {
  try {
    const results = await getDb()
      .select()
      .from(githubIdentityMappings)
      .where(eq(githubIdentityMappings.githubUsername, githubUsername.toLowerCase()))
      .limit(1);

    if (results.length === 0) {
      return `No Discord mapping found for GitHub user "${githubUsername}".`;
    }

    const mapping = results[0];
    const confidencePercent = Math.round((mapping.confidence || 1) * 100);

    return `GitHub user **${githubUsername}** maps to Discord user <@${mapping.discordUserId}> (${confidencePercent}% confidence, source: ${mapping.source})`;
  } catch (error) {
    logger.error('Error querying GitHub identity:', error);
    return `Error looking up mapping for "${githubUsername}"`;
  }
}

/**
 * Learn a new GitHub → Discord mapping
 */
async function learnMapping(
  githubUsername: string,
  discordUserId: string,
  confidence: number = 0.8,
  source: 'manual' | 'learned' | 'heuristic' = 'learned'
): Promise<string> {
  try {
    const now = new Date().toISOString();
    const normalizedUsername = githubUsername.toLowerCase();

    // Check if mapping exists
    const existing = await getDb()
      .select()
      .from(githubIdentityMappings)
      .where(eq(githubIdentityMappings.githubUsername, normalizedUsername))
      .limit(1);

    if (existing.length > 0) {
      // Update if new source is manual or confidence is higher
      const shouldUpdate =
        source === 'manual' || confidence > (existing[0].confidence || 0);

      if (shouldUpdate) {
        await getDb()
          .update(githubIdentityMappings)
          .set({
            discordUserId,
            confidence,
            source,
            updatedAt: now,
          })
          .where(eq(githubIdentityMappings.githubUsername, normalizedUsername));

        return `Updated mapping: GitHub **${githubUsername}** → Discord <@${discordUserId}> (${Math.round(confidence * 100)}% confidence)`;
      } else {
        return `Mapping already exists with higher confidence. Current: GitHub **${githubUsername}** → Discord <@${existing[0].discordUserId}> (${Math.round((existing[0].confidence || 1) * 100)}% confidence)`;
      }
    }

    // Create new mapping
    await getDb().insert(githubIdentityMappings).values({
      githubUsername: normalizedUsername,
      discordUserId,
      confidence,
      source,
      createdAt: now,
      updatedAt: now,
    });

    return `Learned: GitHub **${githubUsername}** → Discord <@${discordUserId}> (${Math.round(confidence * 100)}% confidence)`;
  } catch (error) {
    logger.error('Error learning GitHub identity:', error);
    return `Error saving mapping for "${githubUsername}"`;
  }
}

/**
 * List all known mappings
 */
async function listMappings(): Promise<string> {
  try {
    const mappings = await getDb().select().from(githubIdentityMappings);

    if (mappings.length === 0) {
      return 'No GitHub → Discord mappings known yet.';
    }

    const lines = mappings.map((m: GithubIdentityMapping) => {
      const conf = Math.round((m.confidence || 1) * 100);
      return `• **${m.githubUsername}** → <@${m.discordUserId}> (${conf}%, ${m.source})`;
    });

    return `**Known GitHub → Discord Mappings (${mappings.length}):**\n${lines.join('\n')}`;
  } catch (error) {
    logger.error('Error listing GitHub identities:', error);
    return 'Error retrieving mappings';
  }
}

/**
 * Forget a mapping
 */
async function forgetMapping(githubUsername: string): Promise<string> {
  try {
    const normalizedUsername = githubUsername.toLowerCase();

    const existing = await getDb()
      .select()
      .from(githubIdentityMappings)
      .where(eq(githubIdentityMappings.githubUsername, normalizedUsername))
      .limit(1);

    if (existing.length === 0) {
      return `No mapping found for GitHub user "${githubUsername}"`;
    }

    await getDb()
      .delete(githubIdentityMappings)
      .where(eq(githubIdentityMappings.githubUsername, normalizedUsername));

    return `Forgot mapping for GitHub user **${githubUsername}**`;
  } catch (error) {
    logger.error('Error forgetting GitHub identity:', error);
    return `Error removing mapping for "${githubUsername}"`;
  }
}

/**
 * Suggest possible mappings based on heuristics
 * (This would need Discord guild member access to work properly)
 */
async function suggestMappings(githubUsername: string): Promise<string> {
  // For now, just return a placeholder
  // In a real implementation, this would:
  // 1. Search Discord guild members for similar usernames
  // 2. Check if any members have GitHub linked in their profile
  // 3. Use fuzzy matching on display names

  return `To suggest mappings for **${githubUsername}**, I'd need to search Discord members for similar names. You can teach me directly:

Example: "GitHub user ejfox is Discord user <@123456789>"

Or use the learn action: \`<capability name="github-identity" action="learn" githubUsername="ejfox" discordUserId="123456789" />\``;
}

export const githubIdentityCapability: RegisteredCapability = {
  name: 'github-identity',
  emoji: '🔗',
  supportedActions: ['query', 'learn', 'list', 'forget', 'suggest'],
  description: `Manage GitHub username to Discord user mappings. Use this to know who to @ mention when GitHub events happen.

Actions:
- query: Look up who a GitHub user is on Discord
- learn: Remember a GitHub → Discord mapping (from what you observe or are told)
- list: Show all known mappings
- forget: Remove a mapping
- suggest: Get suggestions for possible mappings (based on similar names)

Use this when:
- You see a GitHub username in a PR and want to know the Discord user
- Someone tells you their GitHub username
- You want to @ mention someone about their PR/review
- You notice someone's GitHub and Discord names match`,

  requiredParams: [],

  examples: [
    '<capability name="github-identity" action="query" githubUsername="ejfox" />',
    '<capability name="github-identity" action="learn" githubUsername="ejfox" discordUserId="123456789" confidence="0.9" source="manual" />',
    '<capability name="github-identity" action="list" />',
    '<capability name="github-identity" action="forget" githubUsername="ejfox" />',
  ],

  handler: async (params: GithubIdentityParams): Promise<string> => {
    const { action } = params;

    logger.info('Executing github-identity capability', { action, params });

    switch (action) {
      case 'query':
        if (!params.githubUsername) {
          return 'Error: githubUsername required for query action';
        }
        return queryMapping(params.githubUsername);

      case 'learn':
        if (!params.githubUsername || !params.discordUserId) {
          return 'Error: githubUsername and discordUserId required for learn action';
        }
        return learnMapping(
          params.githubUsername,
          params.discordUserId,
          params.confidence || 0.8,
          params.source || 'learned'
        );

      case 'list':
        return listMappings();

      case 'forget':
        if (!params.githubUsername) {
          return 'Error: githubUsername required for forget action';
        }
        return forgetMapping(params.githubUsername);

      case 'suggest':
        if (!params.githubUsername) {
          return 'Error: githubUsername required for suggest action';
        }
        return suggestMappings(params.githubUsername);

      default:
        return `Unknown action: ${action}. Valid actions: query, learn, list, forget, suggest`;
    }
  },
};

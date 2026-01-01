import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';

interface ParseIssueLinksParams {
  action: 'parse_issue_links';
  text: string;
  repo?: string; // Format: "owner/repo" for generating full links
}

interface IssueReference {
  number: number;
  link?: string;
  source: string; // The original text that matched (e.g., "#123", "github.com/...")
}

export const discordIssueParserCapability: RegisteredCapability = {
  name: 'discord-issue-parser',
  emoji: '🐛',
  supportedActions: ['parse_issue_links'],
  description:
    'Parse GitHub issue references from Discord message text - extracts #123 patterns and github.com issue URLs',
  requiredParams: ['action', 'text'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action as string;

    try {
      switch (action) {
        case 'parse_issue_links':
          return JSON.stringify(await parseIssueLinks(params));
        default:
          throw new Error(`Unknown discord-issue-parser action: ${action}`);
      }
    } catch (error) {
      logger.error(`Discord issue parser error: ${error}`);
      throw error;
    }
  },
};

/**
 * Extract GitHub issue references from Discord message text
 * Handles patterns like #123 and github.com/owner/repo/issues/456
 * Ignores issue references inside code blocks (backticks)
 */
async function parseIssueLinks(params: { text: string; repo?: string }): Promise<any> {
  const { text, repo } = params;

  logger.info(`Parsing issue references from text (${text.length} chars)`);

  if (!text) {
    throw new Error('Missing required parameter: text');
  }

  try {
    // Remove code blocks to avoid matching issue refs inside code
    const textWithoutCodeBlocks = removeCodeBlocks(text);

    const issues: IssueReference[] = [];
    const seenNumbers = new Set<number>();

    // Pattern 1: Extract simple #number patterns
    const simplePattern = /#(\d+)/g;
    let match;

    while ((match = simplePattern.exec(textWithoutCodeBlocks)) !== null) {
      const number = parseInt(match[1], 10);
      if (!seenNumbers.has(number)) {
        seenNumbers.add(number);
        issues.push({
          number,
          link: repo ? `https://github.com/${repo}/issues/${number}` : undefined,
          source: match[0],
        });
      }
    }

    // Pattern 2: Extract GitHub URLs with issue numbers
    const urlPattern = /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/g;

    while ((match = urlPattern.exec(text)) !== null) {
      const owner = match[1];
      const repoName = match[2];
      const number = parseInt(match[3], 10);

      if (!seenNumbers.has(number)) {
        seenNumbers.add(number);
        issues.push({
          number,
          link: `https://github.com/${owner}/${repoName}/issues/${number}`,
          source: match[0],
        });
      }
    }

    logger.info(`Found ${issues.length} unique issue references`);

    return {
      success: true,
      data: {
        issueCount: issues.length,
        issues: issues.sort((a, b) => a.number - b.number),
        repo: repo || null,
      },
    };
  } catch (error) {
    logger.error('Failed to parse issue references:', error);
    throw error;
  }
}

/**
 * Remove code blocks (both single backtick and triple backtick) from text
 * This prevents matching issue references that are part of code examples
 */
function removeCodeBlocks(text: string): string {
  // Remove triple backtick code blocks first
  let cleaned = text.replace(/```[\s\S]*?```/g, '');

  // Remove single backtick inline code
  cleaned = cleaned.replace(/`[^`]*?`/g, '');

  return cleaned;
}

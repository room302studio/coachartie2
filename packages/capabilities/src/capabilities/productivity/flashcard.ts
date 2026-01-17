import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

const FLASHCARD_API_BASE = 'https://ejfox.com/api/flashcards';

interface FlashcardResponse {
  id: string;
  front: string;
  back: string;
  hints: string[];
  deckId: string;
  deckName: string;
  course: string;
}

interface DeckStats {
  id: string;
  name: string;
  course: string;
  cards: number;
}

interface StatsResponse {
  totalDecks: number;
  totalCards: number;
  byCourse: Record<string, { decks: number; cards: number }>;
  largestDeck: { id: string; name: string; cards: number };
  smallestDeck: { id: string; name: string; cards: number };
  decks: DeckStats[];
}

interface SearchResponse {
  query: string;
  total: number;
  results: FlashcardResponse[];
}

/**
 * Flashcard capability - Quiz and study with flashcards
 *
 * Supported actions:
 * - random: Get a random flashcard (optionally from a specific deck)
 * - search: Search flashcards by content
 * - decks: List all available decks
 * - stats: Get flashcard collection statistics
 * - quiz: Get a flashcard formatted for quizzing (hides answer initially)
 *
 * Parameters:
 * - deck: Deck ID for filtering (optional, for random/quiz actions)
 * - query: Search query (required for search action)
 * - limit: Max results for search (optional, default 10)
 *
 * Available decks: COMPUTERS, ELECTRICAL_AND_RADIO, POLITICS, RUBIKS_2x2, SAR_AND_WILDERNESS
 *
 * Examples:
 * <capability name="flashcard" action="random" />
 * <capability name="flashcard" action="random" deck="COMPUTERS" />
 * <capability name="flashcard" action="quiz" deck="ELECTRICAL_AND_RADIO" />
 * <capability name="flashcard" action="search" query="vim" limit="5" />
 * <capability name="flashcard" action="decks" />
 * <capability name="flashcard" action="stats" />
 */
export const flashcardCapability: RegisteredCapability = {
  name: 'flashcard',
  emoji: '🎴',
  supportedActions: ['random', 'search', 'decks', 'stats', 'quiz'],
  description:
    'Quiz users with flashcards from various topics (computers, radio, politics, Rubiks cube, wilderness survival)',
  examples: [
    '<capability name="flashcard" action="quiz" /> - Get a random quiz question',
    '<capability name="flashcard" action="quiz" deck="COMPUTERS" /> - Quiz from computers deck',
    '<capability name="flashcard" action="random" /> - Get a random card with answer',
    '<capability name="flashcard" action="search" query="vim" /> - Search for vim-related cards',
    '<capability name="flashcard" action="decks" /> - List available decks',
  ],
  handler: async (params) => {
    const { action, deck, query, limit = 10 } = params;

    try {
      switch (action) {
        case 'random': {
          const url = deck
            ? `${FLASHCARD_API_BASE}/random/${deck}`
            : `${FLASHCARD_API_BASE}/random`;

          logger.info(`🎴 Fetching random flashcard from ${url}`);
          const response = await fetch(url);

          if (!response.ok) {
            if (response.status === 404) {
              throw new Error(
                `Deck "${deck}" not found. Available decks: COMPUTERS, ELECTRICAL_AND_RADIO, POLITICS, RUBIKS_2x2, SAR_AND_WILDERNESS`
              );
            }
            throw new Error(`Failed to fetch flashcard: ${response.status}`);
          }

          const card = (await response.json()) as FlashcardResponse;
          logger.info(`✅ Got flashcard: ${card.id} from ${card.deckName}`);

          return formatCardWithAnswer(card);
        }

        case 'quiz': {
          const url = deck
            ? `${FLASHCARD_API_BASE}/random/${deck}`
            : `${FLASHCARD_API_BASE}/random`;

          logger.info(`🎴 Fetching quiz question from ${url}`);
          const response = await fetch(url);

          if (!response.ok) {
            if (response.status === 404) {
              throw new Error(
                `Deck "${deck}" not found. Available decks: COMPUTERS, ELECTRICAL_AND_RADIO, POLITICS, RUBIKS_2x2, SAR_AND_WILDERNESS`
              );
            }
            throw new Error(`Failed to fetch flashcard: ${response.status}`);
          }

          const card = (await response.json()) as FlashcardResponse;
          logger.info(`✅ Got quiz card: ${card.id} from ${card.deckName}`);

          return formatQuizQuestion(card);
        }

        case 'search': {
          if (!query) {
            throw new Error('Query parameter is required for search action');
          }

          const url = `${FLASHCARD_API_BASE}/search?q=${encodeURIComponent(query as string)}&limit=${limit}`;
          logger.info(`🎴 Searching flashcards: ${query}`);
          const response = await fetch(url);

          if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
          }

          const results = (await response.json()) as SearchResponse;
          logger.info(`✅ Found ${results.total} cards matching "${query}"`);

          if (results.total === 0) {
            return `No flashcards found matching "${query}". Try a different search term.`;
          }

          const cardList = results.results
            .map(
              (card, i) =>
                `${i + 1}. [${card.deckName}] Q: ${card.front}\n   A: ${card.back}${card.hints.length > 0 ? `\n   Hints: ${card.hints.join(', ')}` : ''}`
            )
            .join('\n\n');

          return `Found ${results.total} flashcards matching "${query}":\n\n${cardList}`;
        }

        case 'decks': {
          logger.info(`🎴 Fetching available decks`);
          const response = await fetch(`${FLASHCARD_API_BASE}/stats`);

          if (!response.ok) {
            throw new Error(`Failed to fetch decks: ${response.status}`);
          }

          const stats = (await response.json()) as StatsResponse;
          logger.info(`✅ Got ${stats.totalDecks} decks`);

          const deckList = stats.decks
            .map((d) => `- **${d.id}**: ${d.cards} cards (${d.course})`)
            .join('\n');

          return `Available flashcard decks (${stats.totalDecks} total, ${stats.totalCards} cards):\n\n${deckList}\n\nUse deck="DECK_ID" to quiz from a specific deck.`;
        }

        case 'stats': {
          logger.info(`🎴 Fetching flashcard stats`);
          const response = await fetch(`${FLASHCARD_API_BASE}/stats`);

          if (!response.ok) {
            throw new Error(`Failed to fetch stats: ${response.status}`);
          }

          const stats = (await response.json()) as StatsResponse;
          logger.info(`✅ Got flashcard stats`);

          return `Flashcard Collection Statistics:
- Total decks: ${stats.totalDecks}
- Total cards: ${stats.totalCards}
- Largest deck: ${stats.largestDeck.name} (${stats.largestDeck.cards} cards)
- Smallest deck: ${stats.smallestDeck.name} (${stats.smallestDeck.cards} cards)

Decks by size:
${stats.decks.map((d) => `  ${d.name}: ${d.cards} cards`).join('\n')}`;
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Supported: random, quiz, search, decks, stats`
          );
      }
    } catch (error) {
      logger.error(`❌ Flashcard capability error:`, error);
      throw error;
    }
  },
};

function formatCardWithAnswer(card: FlashcardResponse): string {
  let result = `**Flashcard** [${card.deckName}]\n\n`;
  result += `**Question:** ${card.front}\n\n`;
  result += `**Answer:** ${card.back}`;

  if (card.hints.length > 0) {
    result += `\n\n**Hints:** ${card.hints.join(', ')}`;
  }

  result += `\n\n_Card ID: ${card.id}_`;
  return result;
}

function formatQuizQuestion(card: FlashcardResponse): string {
  let result = `**Quiz Question** [${card.deckName}]\n\n`;
  result += `**Q:** ${card.front}\n\n`;

  if (card.hints.length > 0) {
    result += `_Hints available: ${card.hints.length}_\n\n`;
  }

  result += `---\n`;
  result += `_Ask the user to answer, then reveal:_\n`;
  result += `**Answer:** ||${card.back}||\n`;
  result += `_Card ID: ${card.id}_`;

  return result;
}

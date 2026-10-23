import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

enum ButtonStyle {
  Primary = 1,
  Secondary = 2,
  Success = 3,
  Danger = 4,
}

/**
 * Ask Question Capability - Ask user questions with multiple choice options
 *
 * Modeled after Claude Code's AskUserQuestion tool, this allows Artie to ask
 * questions during execution and wait for user responses.
 */

interface QuestionOption {
  label: string; // Display text (e.g., "OAuth 2.0")
  description?: string; // Optional explanation of what this option means
  value?: string; // Optional value to return (defaults to label)
}

interface Question {
  question: string; // The full question to ask
  header?: string; // Short label (max 12 chars) e.g., "Auth method"
  options: QuestionOption[]; // 2-25 options
  multiSelect?: boolean; // Allow multiple selections (default: false)
}

interface AskQuestionParams {
  action?: string; // Not used, but included for consistency
  questions?: Question[]; // Array of questions (1-4 supported)
  question?: string; // Single question shorthand
  header?: string; // Single question header
  options?: QuestionOption[]; // Single question options
  multiSelect?: boolean; // Single question multiSelect
}

const handler = async (params: AskQuestionParams, content?: string): Promise<string> => {
  try {
    // Parse questions from params or content
    let questions: Question[] = [];

    // Try to parse from content first (JSON format)
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          questions = parsed;
        } else if (parsed.questions) {
          questions = parsed.questions;
        } else if (parsed.question && parsed.options) {
          // Single question format
          questions = [parsed];
        }
      } catch (e) {
        logger.warn('Failed to parse ask-question content as JSON:', e);
      }
    }

    // Fallback to params if no content or parsing failed
    if (questions.length === 0) {
      if (params.questions && params.questions.length > 0) {
        questions = params.questions;
      } else if (params.question && params.options) {
        // Single question shorthand
        questions = [
          {
            question: params.question,
            header: params.header,
            options: params.options,
            multiSelect: params.multiSelect || false,
          },
        ];
      }
    }

    // Validate
    if (questions.length === 0) {
      throw new Error(
        'ask-question requires at least one question with options.\n\n' +
          'Format:\n' +
          '<capability name="ask-question">\n' +
          '  {"question": "Which approach?", "header": "Method", "options": [\n' +
          '    {"label": "OAuth", "description": "Standard OAuth 2.0 flow"},\n' +
          '    {"label": "JWT", "description": "JSON Web Tokens"}\n' +
          '  ]}\n' +
          '</capability>'
      );
    }

    if (questions.length > 4) {
      throw new Error('Maximum 4 questions per ask-question capability');
    }

    // Validate each question
    for (const q of questions) {
      if (!q.question || !q.options || q.options.length < 2) {
        throw new Error('Each question must have a question string and at least 2 options');
      }
      if (q.options.length > 25) {
        throw new Error('Maximum 25 options per question (Discord limit)');
      }
      if (q.header && q.header.length > 12) {
        logger.warn(`Header "${q.header}" exceeds 12 chars, will be truncated`);
        q.header = q.header.substring(0, 12);
      }
    }

    // For now, support single question only
    // Multi-question support would require more complex interaction handling
    if (questions.length > 1) {
      logger.warn('Multiple questions detected, only first will be used');
    }

    const question = questions[0];

    // Choose UI format based on option count and multiSelect
    if (question.multiSelect || question.options.length > 5) {
      return await createSelectMenu(question);
    } else {
      return await createButtons(question);
    }
  } catch (error) {
    logger.error('Ask Question capability error:', {
      error: error instanceof Error ? error.message : String(error),
      params,
      content,
    });
    throw new Error(
      `Failed to ask question: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

async function createButtons(question: Question): Promise<string> {
  const customId = `ask_${Date.now()}`;
  const actionRows: any[] = [];

  // Create buttons (max 5 per row, max 5 rows)
  const buttons = question.options.slice(0, 25);

  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5);
    const actionRow = {
      type: 1, // ActionRow
      components: [] as any[],
    };

    rowButtons.forEach((opt, _index) => {
      const button = {
        type: 2, // Button
        custom_id: `${customId}_${opt.value || opt.label}`,
        label: opt.label,
        style: ButtonStyle.Primary,
      };

      actionRow.components.push(button);
    });

    actionRows.push(actionRow);
  }

  // Build display text
  let displayText = `**${question.question}**`;
  if (question.header) {
    displayText = `**${question.header}:** ${question.question}`;
  }

  // Add option descriptions if provided
  const hasDescriptions = question.options.some((opt) => opt.description);
  if (hasDescriptions) {
    displayText += '\n\n';
    question.options.forEach((opt) => {
      if (opt.description) {
        displayText += `• **${opt.label}:** ${opt.description}\n`;
      }
    });
  }

  logger.info('❓ Created question with buttons:', {
    question: question.question,
    optionCount: buttons.length,
  });

  return `DISCORD_UI:ASK_QUESTION:${JSON.stringify({
    type: 'buttons',
    customId,
    question: question.question,
    header: question.header,
    actionRows,
    options: question.options,
  })}:${displayText}`;
}

async function createSelectMenu(question: Question): Promise<string> {
  const customId = `ask_${Date.now()}`;

  // Map options to select menu format
  const options = question.options.slice(0, 25).map((opt) => ({
    label: opt.label,
    value: opt.value || opt.label,
    description: opt.description?.substring(0, 100), // Discord limit
  }));

  const selectMenu = {
    type: 3, // StringSelectMenu
    custom_id: customId,
    placeholder: question.header || 'Choose an option...',
    min_values: question.multiSelect ? 1 : 1,
    max_values: question.multiSelect ? options.length : 1,
    options,
  };

  const actionRow = {
    type: 1, // ActionRow
    components: [selectMenu],
  };

  // Build display text
  let displayText = `**${question.question}**`;
  if (question.header) {
    displayText = `**${question.header}:** ${question.question}`;
  }

  if (question.multiSelect) {
    displayText += '\n_You can select multiple options_';
  }

  logger.info('❓ Created question with select menu:', {
    question: question.question,
    optionCount: options.length,
    multiSelect: question.multiSelect,
  });

  return `DISCORD_UI:ASK_QUESTION:${JSON.stringify({
    type: 'select',
    customId,
    question: question.question,
    header: question.header,
    actionRow,
    options: question.options,
    multiSelect: question.multiSelect,
  })}:${displayText}`;
}

export const askQuestionCapability: RegisteredCapability = {
  name: 'ask-question',
  emoji: '❓',
  supportedActions: ['ask'], // Single action for simplicity
  description:
    'Ask user questions with multiple choice options during execution. Returns user selection. Supports 2-25 options per question with optional descriptions.',
  requiredParams: [],
  examples: [
    // Simple question with 2 options
    '<capability name="ask-question">\n' +
      '{"question": "Should I proceed with the deployment?", "options": [\n' +
      '  {"label": "Yes, deploy now"},\n' +
      '  {"label": "No, wait"}\n' +
      ']}\n' +
      '</capability>',

    // Question with descriptions
    '<capability name="ask-question">\n' +
      '{"question": "Which authentication method?", "header": "Auth", "options": [\n' +
      '  {"label": "OAuth 2.0", "description": "Industry standard, more complex"},\n' +
      '  {"label": "JWT", "description": "Simpler, stateless tokens"},\n' +
      '  {"label": "API Keys", "description": "Simplest, less secure"}\n' +
      ']}\n' +
      '</capability>',

    // Multi-select question
    '<capability name="ask-question">\n' +
      '{"question": "Which features to enable?", "multiSelect": true, "options": [\n' +
      '  {"label": "Dark mode"},\n' +
      '  {"label": "Notifications"},\n' +
      '  {"label": "Analytics"}\n' +
      ']}\n' +
      '</capability>',
  ],
  handler,
};

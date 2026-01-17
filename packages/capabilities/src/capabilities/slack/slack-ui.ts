import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';

// Slack Block Kit types (without importing the library)
enum ButtonStyle {
  Primary = 'primary',
  Danger = 'danger',
}

enum BlockType {
  Section = 'section',
  Actions = 'actions',
  Input = 'input',
  Divider = 'divider',
  Header = 'header',
  Context = 'context',
}

enum ElementType {
  Button = 'button',
  StaticSelect = 'static_select',
  UsersSelect = 'users_select',
  ConversationsSelect = 'conversations_select',
  ChannelsSelect = 'channels_select',
  PlainTextInput = 'plain_text_input',
}

enum TextType {
  PlainText = 'plain_text',
  Mrkdwn = 'mrkdwn',
}

/**
 * Slack UI Capability - Generate interactive Slack components via XML
 *
 * Allows the AI to create modals, buttons, select menus, and rich text blocks
 * dynamically through XML capabilities using Slack's Block Kit framework.
 */

interface SlackUIParams {
  action: 'modal' | 'buttons' | 'select' | 'rich-text';
  title?: string;
  callbackId?: string;
  submitLabel?: string;
  closeLabel?: string;
  style?: string;
  placeholder?: string;
  selectType?: 'static' | 'users' | 'conversations' | 'channels';
  options?: Array<{ text: string; value: string; description?: string }>;
  buttons?: Array<{ text: string; style?: string; actionId?: string; value?: string }>;
  inputs?: Array<{
    label: string;
    blockId: string;
    actionId?: string;
    placeholder?: string;
    multiline?: boolean;
    optional?: boolean;
    minLength?: number;
    maxLength?: number;
  }>;
  blocks?: Array<{
    type: 'section' | 'divider' | 'header' | 'context';
    text?: string;
    fields?: Array<string>;
  }>;
}

const handler = async (params: SlackUIParams, content?: string): Promise<string> => {
  const { action } = params;

  try {
    // Parse configuration from content (JSON)
    let config: any = {};
    if (content) {
      try {
        // Handle both array format [{"text":"Yes",...}] and object format {"buttons":[...]}
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          // For buttons: [{"text":"Yes",...}] -> {"buttons": [...]}
          if (action === 'buttons') {
            config.buttons = parsed;
          } else if (action === 'select') {
            config.options = parsed;
          } else if (action === 'rich-text') {
            config.blocks = parsed;
          }
        } else {
          config = parsed;
        }
      } catch (e) {
        logger.warn(`Failed to parse JSON content: ${content}`, e);
      }
    }

    // Merge params and config
    const mergedParams = { ...params, ...config };

    switch (action) {
      case 'modal':
        return await createModal(mergedParams, content);

      case 'buttons':
        return await createButtons(mergedParams, content);

      case 'select':
        return await createSelectMenu(mergedParams, content);

      case 'rich-text':
        return await createRichText(mergedParams, content);

      default:
        throw new Error(
          `Unsupported action: ${action}\n\n` +
            `Available actions: modal, buttons, select, rich-text\n\n` +
            `Examples:\n` +
            `• <capability name="slack-ui" action="buttons" data='[{"text":"Yes"},{"text":"No"}]' />\n` +
            `• <capability name="slack-ui" action="select" data='{"options":[{"text":"Option 1","value":"1"}]}' />\n` +
            `• <capability name="slack-ui" action="modal" data='{"title":"Form","inputs":[{"label":"Name"}]}' />\n` +
            `• <capability name="slack-ui" action="rich-text" data='[{"type":"header","text":"Title"},{"type":"section","text":"Content"}]' />`
        );
    }
  } catch (error) {
    logger.error('Slack UI capability error:', {
      action,
      error: error instanceof Error ? error.message : String(error),
      params,
      content,
    });
    throw new Error(
      `Failed to create Slack UI component: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Creates a Slack modal (view) with input fields
 *
 * @param params - Modal parameters including title, inputs, and submit/close labels
 * @param content - Optional content to parse for additional inputs
 * @returns Formatted response string with modal JSON
 */
async function createModal(params: SlackUIParams, content?: string): Promise<string> {
  const callbackId = params.callbackId || `modal_${Date.now()}`;
  const title = params.title || 'Form';
  const submitLabel = params.submitLabel || 'Submit';
  const closeLabel = params.closeLabel || 'Cancel';

  // Parse inputs from params or content
  const inputs = params.inputs || parseInputsFromContent(content);

  if (!inputs || inputs.length === 0) {
    throw new Error('Modal requires at least one input field');
  }

  // Create modal view JSON structure using Block Kit
  const modalView = {
    type: 'modal',
    callback_id: callbackId,
    title: {
      type: TextType.PlainText,
      text: title,
    },
    submit: {
      type: TextType.PlainText,
      text: submitLabel,
    },
    close: {
      type: TextType.PlainText,
      text: closeLabel,
    },
    blocks: [] as any[],
  };

  // Add up to 100 blocks (Slack limit), but typically much fewer for inputs
  for (let i = 0; i < Math.min(inputs.length, 20); i++) {
    const input = inputs[i];
    const blockId = input.blockId || `block_${i}`;
    const actionId = input.actionId || `input_${i}`;

    const inputBlock: any = {
      type: BlockType.Input,
      block_id: blockId,
      label: {
        type: TextType.PlainText,
        text: input.label,
      },
      element: {
        type: ElementType.PlainTextInput,
        action_id: actionId,
        multiline: input.multiline || false,
      },
      optional: input.optional || false,
    };

    if (input.placeholder) {
      inputBlock.element.placeholder = {
        type: TextType.PlainText,
        text: input.placeholder,
      };
    }
    if (input.minLength) {
      inputBlock.element.min_length = input.minLength;
    }
    if (input.maxLength) {
      inputBlock.element.max_length = input.maxLength;
    }

    modalView.blocks.push(inputBlock);
  }

  logger.info('🎨 Generated Slack modal:', { callbackId, title, inputCount: inputs.length });

  // Return special response format that Slack consumer will recognize
  return `SLACK_UI:MODAL:${JSON.stringify({
    callbackId,
    view: modalView,
    title,
    inputCount: inputs.length,
  })}:Modal "${title}" with ${inputs.length} input fields created! Waiting for user interaction...`;
}

/**
 * Creates an actions block with interactive buttons
 *
 * @param params - Button parameters including button configurations
 * @param content - Optional content to parse for additional buttons
 * @returns Formatted response string with buttons JSON
 */
async function createButtons(params: SlackUIParams, content?: string): Promise<string> {
  if (!params.buttons || params.buttons.length === 0) {
    throw new Error('Button action requires buttons array');
  }

  const buttons = params.buttons.slice(0, 25); // Slack limit: 25 buttons per block

  // Slack allows up to 5 buttons per actions block, so we create multiple blocks if needed
  const blocks: any[] = [];

  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5);
    const actionsBlock = {
      type: BlockType.Actions,
      elements: [] as any[],
    };

    rowButtons.forEach((btn, index) => {
      const button: any = {
        type: ElementType.Button,
        action_id: btn.actionId || `btn_${i + index}`,
        text: {
          type: TextType.PlainText,
          text: btn.text,
        },
      };

      if (btn.value) {
        button.value = btn.value;
      }

      if (btn.style) {
        const style = getButtonStyle(btn.style);
        if (style) {
          button.style = style;
        }
      }

      actionsBlock.elements.push(button);
    });

    blocks.push(actionsBlock);
  }

  logger.info('🔘 Generated Slack buttons:', {
    buttonCount: buttons.length,
    blocks: blocks.length,
  });

  return `SLACK_UI:BUTTONS:${JSON.stringify({
    blocks,
    buttonCount: buttons.length,
    blockCount: blocks.length,
  })}:Created ${buttons.length} interactive buttons! Click to interact.`;
}

/**
 * Creates a select menu block for user interaction
 *
 * @param params - Select menu parameters including options and type
 * @param content - Optional content to parse for additional options
 * @returns Formatted response string with select menu JSON
 */
async function createSelectMenu(params: SlackUIParams, content?: string): Promise<string> {
  const selectType = params.selectType || 'static';
  const actionId = params.callbackId || `select_${Date.now()}`;
  const placeholder = params.placeholder || 'Choose an option...';

  let selectMenu: any = {
    action_id: actionId,
    placeholder: {
      type: TextType.PlainText,
      text: placeholder,
    },
  };

  // Set select menu type and options based on selectType
  switch (selectType) {
    case 'static':
      if (!params.options || params.options.length === 0) {
        throw new Error('Static select menu requires options array');
      }

      const options = params.options.slice(0, 100).map((opt) => ({
        text: {
          type: TextType.PlainText,
          text: opt.text,
        },
        value: opt.value,
        description: opt.description
          ? {
              type: TextType.PlainText,
              text: opt.description,
            }
          : undefined,
      }));

      selectMenu.type = ElementType.StaticSelect;
      selectMenu.options = options;
      break;

    case 'users':
      selectMenu.type = ElementType.UsersSelect;
      break;

    case 'conversations':
      selectMenu.type = ElementType.ConversationsSelect;
      break;

    case 'channels':
      selectMenu.type = ElementType.ChannelsSelect;
      break;

    default:
      throw new Error(`Unsupported select type: ${selectType}`);
  }

  const actionsBlock = {
    type: BlockType.Actions,
    elements: [selectMenu],
  };

  logger.info('📋 Generated Slack select menu:', {
    actionId,
    selectType,
    optionCount: selectType === 'static' ? params.options?.length || 0 : 'N/A',
  });

  return `SLACK_UI:SELECT:${JSON.stringify({
    block: actionsBlock,
    actionId,
    selectType,
    optionCount: selectType === 'static' ? params.options?.length || 0 : null,
  })}:Select menu${selectType === 'static' ? ` with ${params.options?.length || 0} options` : ''} created! Choose an option to continue.`;
}

/**
 * Creates rich text blocks for formatted messages
 *
 * @param params - Rich text parameters including block configurations
 * @param content - Optional content to parse for additional blocks
 * @returns Formatted response string with rich text blocks JSON
 */
async function createRichText(params: SlackUIParams, content?: string): Promise<string> {
  if (!params.blocks || params.blocks.length === 0) {
    throw new Error('Rich text action requires blocks array');
  }

  const blocks: any[] = [];

  for (const blockConfig of params.blocks) {
    let block: any;

    switch (blockConfig.type) {
      case 'section':
        block = {
          type: BlockType.Section,
        };

        if (blockConfig.text) {
          block.text = {
            type: TextType.Mrkdwn,
            text: blockConfig.text,
          };
        }

        if (blockConfig.fields && blockConfig.fields.length > 0) {
          block.fields = blockConfig.fields.slice(0, 10).map((field) => ({
            type: TextType.Mrkdwn,
            text: field,
          }));
        }
        break;

      case 'divider':
        block = {
          type: BlockType.Divider,
        };
        break;

      case 'header':
        if (!blockConfig.text) {
          throw new Error('Header block requires text');
        }
        block = {
          type: BlockType.Header,
          text: {
            type: TextType.PlainText,
            text: blockConfig.text,
          },
        };
        break;

      case 'context':
        if (!blockConfig.text && (!blockConfig.fields || blockConfig.fields.length === 0)) {
          throw new Error('Context block requires text or fields');
        }
        block = {
          type: BlockType.Context,
          elements: [],
        };

        if (blockConfig.text) {
          block.elements.push({
            type: TextType.Mrkdwn,
            text: blockConfig.text,
          });
        }

        if (blockConfig.fields && blockConfig.fields.length > 0) {
          block.elements.push(
            ...blockConfig.fields.slice(0, 10).map((field) => ({
              type: TextType.Mrkdwn,
              text: field,
            }))
          );
        }
        break;

      default:
        logger.warn(`Unsupported block type: ${blockConfig.type}`);
        continue;
    }

    blocks.push(block);
  }

  logger.info('📝 Generated Slack rich text blocks:', {
    blockCount: blocks.length,
  });

  return `SLACK_UI:RICH_TEXT:${JSON.stringify({
    blocks,
    blockCount: blocks.length,
  })}:Created ${blocks.length} rich text blocks for formatted message display.`;
}

// Helper functions

/**
 * Parses simple text content into input field configurations
 *
 * @param content - Text content to parse
 * @returns Array of input field configurations
 */
function parseInputsFromContent(content?: string): Array<any> {
  if (!content) {
    return [];
  }

  // Simple parsing - could be enhanced with XML parsing
  const lines = content.split('\n').filter((line) => line.trim());
  return lines.map((line, index) => ({
    label: line.trim(),
    blockId: `block_${index}`,
    actionId: `field_${index}`,
    multiline: false,
    optional: false,
  }));
}

/**
 * Converts a style string to Slack ButtonStyle enum
 *
 * @param style - Style string (primary, danger, etc.)
 * @returns Slack ButtonStyle or undefined for default
 */
function getButtonStyle(style?: string): string | undefined {
  switch (style?.toLowerCase()) {
    case 'primary':
      return ButtonStyle.Primary;
    case 'danger':
      return ButtonStyle.Danger;
    default:
      return undefined; // Slack defaults to normal style if not specified
  }
}

export const slackUICapability: RegisteredCapability = {
  name: 'slack-ui',
  emoji: '💼',
  supportedActions: ['modal', 'buttons', 'select', 'rich-text'],
  description:
    'Create interactive Slack UI components using Block Kit (modals, buttons, select menus, rich text blocks)',
  requiredParams: [], // action is automatically injected by capability registry
  examples: [
    '<capability name="slack-ui" action="modal" data=\'{"title":"User Feedback","inputs":[{"label":"Name","optional":false},{"label":"Email"},{"label":"Message","multiline":true}]}\' />',
    '<capability name="slack-ui" action="buttons" data=\'[{"text":"Yes","style":"primary"},{"text":"No","style":"danger"},{"text":"Maybe"}]\' />',
    '<capability name="slack-ui" action="select" data=\'{"placeholder":"Choose one...","selectType":"static","options":[{"text":"Option 1","value":"1"},{"text":"Option 2","value":"2"}]}\' />',
    '<capability name="slack-ui" action="select" data=\'{"placeholder":"Select a user...","selectType":"users"}\' />',
    '<capability name="slack-ui" action="rich-text" data=\'[{"type":"header","text":"Welcome!"},{"type":"section","text":"This is a *formatted* message"},{"type":"divider"},{"type":"context","text":"Footer text"}]\' />',
  ],
  handler,
};

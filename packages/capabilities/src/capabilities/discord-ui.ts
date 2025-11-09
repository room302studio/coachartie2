import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';

// Discord.js component types (without importing the library)
enum TextInputStyle {
  Short = 1,
  Paragraph = 2,
}

enum ButtonStyle {
  Primary = 1,
  Secondary = 2,
  Success = 3,
  Danger = 4,
  Link = 5,
}

enum ApplicationCommandType {
  ChatInput = 1,
  User = 2,
  Message = 3,
}

/**
 * Discord UI Capability - Generate interactive Discord components via XML
 *
 * Allows the AI to create modals, buttons, select menus, and context menus
 * dynamically through XML capabilities.
 */

interface DiscordUIParams {
  action: 'modal' | 'buttons' | 'select' | 'context-menu';
  title?: string;
  customId?: string;
  name?: string;
  style?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  buttons?: Array<{ label: string; style?: string; customId?: string }>;
  inputs?: Array<{
    label: string;
    customId: string;
    style?: 'short' | 'paragraph';
    placeholder?: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
  }>;
}

const handler = async (params: DiscordUIParams, content?: string): Promise<string> => {
  const { action } = params;

  try {
    // Parse configuration from content (JSON)
    let config: any = {};
    if (content) {
      try {
        // Handle both array format [{"label":"Yes",...}] and object format {"buttons":[...]}
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          // For buttons: [{"label":"Yes",...}] -> {"buttons": [...]}
          if (action === 'buttons') {
            config.buttons = parsed;
          } else if (action === 'select') {
            config.options = parsed;
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

      case 'context-menu':
        return await createContextMenu(mergedParams, content);

      default:
        throw new Error(
          `Unsupported action: ${action}\n\n` +
            `Available actions: modal, buttons, select, context-menu\n\n` +
            `Examples:\n` +
            `• <capability name="discord-ui" action="buttons" data='[{"label":"Yes"},{"label":"No"}]' />\n` +
            `• <capability name="discord-ui" action="select" data='{"options":[{"label":"Option 1","value":"1"}]}' />\n` +
            `• <capability name="discord-ui" action="modal" data='{"title":"Form","inputs":[{"label":"Name"}]}' />`
        );
    }
  } catch (error) {
    logger.error('Discord UI capability error:', {
      action,
      error: error instanceof Error ? error.message : String(error),
      params,
      content,
    });
    throw new Error(
      `Failed to create Discord UI component: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

async function createModal(params: DiscordUIParams, content?: string): Promise<string> {
  const modalId = params.customId || `modal_${Date.now()}`;
  const title = params.title || 'Form';

  // Parse inputs from params or content
  const inputs = params.inputs || parseInputsFromContent(content);

  if (!inputs || inputs.length === 0) {
    throw new Error('Modal requires at least one input field');
  }

  // Create modal JSON structure directly
  const modalJson = {
    custom_id: modalId,
    title: title,
    components: [] as any[],
  };

  // Add up to 5 input fields (Discord limit)
  for (let i = 0; i < Math.min(inputs.length, 5); i++) {
    const input = inputs[i];
    const textInput: any = {
      type: 4, // TextInput component type
      custom_id: input.customId || `input_${i}`,
      label: input.label,
      style: input.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short,
    };

    if (input.placeholder) {
      textInput.placeholder = input.placeholder;
    }
    if (input.required !== undefined) {
      textInput.required = input.required;
    }
    if (input.minLength) {
      textInput.min_length = input.minLength;
    }
    if (input.maxLength) {
      textInput.max_length = input.maxLength;
    }

    const actionRow = {
      type: 1, // ActionRow component type
      components: [textInput],
    };

    modalJson.components.push(actionRow);
  }

  logger.info('🎨 Generated Discord modal:', { modalId, title, inputCount: inputs.length });

  // Return special response format that Discord consumer will recognize
  return `DISCORD_UI:MODAL:${JSON.stringify({
    modalId,
    modal: modalJson,
    title,
    inputCount: inputs.length,
  })}:Modal "${title}" with ${inputs.length} input fields created! Waiting for user interaction...`;
}

async function createButtons(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.buttons || params.buttons.length === 0) {
    throw new Error('Button action requires buttons array');
  }

  const actionRows: any[] = [];
  const buttons = params.buttons.slice(0, 25); // Discord limit: 25 buttons total

  // Discord allows max 5 buttons per row, max 5 rows
  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5);
    const actionRow = {
      type: 1, // ActionRow component type
      components: [] as any[],
    };

    rowButtons.forEach((btn, index) => {
      const button = {
        type: 2, // Button component type
        custom_id: btn.customId || `btn_${i + index}`,
        label: btn.label,
        style: getButtonStyle(btn.style),
      };

      actionRow.components.push(button);
    });

    actionRows.push(actionRow);
  }

  logger.info('🔘 Generated Discord buttons:', {
    buttonCount: buttons.length,
    rows: actionRows.length,
  });

  return `DISCORD_UI:BUTTONS:${JSON.stringify({
    actionRows,
    buttonCount: buttons.length,
    rows: actionRows.length,
  })}:Created ${buttons.length} interactive buttons! Click to interact.`;
}

async function createSelectMenu(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.options || params.options.length === 0) {
    throw new Error('Select menu requires options array');
  }

  const customId = params.customId || `select_${Date.now()}`;
  const placeholder = params.placeholder || 'Choose an option...';

  // Add options (max 25)
  const options = params.options.slice(0, 25).map((opt) => ({
    label: opt.label,
    value: opt.value,
    description: opt.description,
  }));

  const selectMenu = {
    type: 3, // StringSelectMenu component type
    custom_id: customId,
    placeholder,
    min_values: 1,
    max_values: 1,
    options,
  };

  const actionRow = {
    type: 1, // ActionRow component type
    components: [selectMenu],
  };

  logger.info('📋 Generated Discord select menu:', {
    customId,
    optionCount: options.length,
  });

  return `DISCORD_UI:SELECT:${JSON.stringify({
    actionRow,
    customId,
    optionCount: options.length,
  })}:Select menu with ${options.length} options created! Choose an option to continue.`;
}

async function createContextMenu(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.name) {
    throw new Error('Context menu requires name parameter');
  }

  const contextMenu = {
    name: params.name,
    type: ApplicationCommandType.Message, // Can also be User or ChatInput
  };

  logger.info('📝 Generated Discord context menu:', { name: params.name });

  return `DISCORD_UI:CONTEXT_MENU:${JSON.stringify({
    command: contextMenu,
    name: params.name,
  })}:Context menu "${params.name}" created! This will be available when right-clicking messages.`;
}

// Helper functions
function parseInputsFromContent(content?: string): Array<any> {
  if (!content) {
    return [];
  }

  // Simple parsing - could be enhanced with XML parsing
  const lines = content.split('\n').filter((line) => line.trim());
  return lines.map((line, index) => ({
    label: line.trim(),
    customId: `field_${index}`,
    style: 'short',
    required: true,
  }));
}

function getButtonStyle(style?: string): ButtonStyle {
  switch (style?.toLowerCase()) {
    case 'primary':
      return ButtonStyle.Primary;
    case 'secondary':
      return ButtonStyle.Secondary;
    case 'success':
      return ButtonStyle.Success;
    case 'danger':
      return ButtonStyle.Danger;
    case 'link':
      return ButtonStyle.Link;
    default:
      return ButtonStyle.Secondary;
  }
}

export const discordUICapability: RegisteredCapability = {
  name: 'discord-ui',
  supportedActions: ['modal', 'buttons', 'select', 'context-menu'],
  description:
    'Create interactive Discord UI components (modals, buttons, select menus, context menus)',
  requiredParams: [], // action is automatically injected by capability registry
  examples: [
    '<capability name="discord-ui" action="modal" data=\'{"title":"User Feedback","inputs":[{"label":"Name","required":true},{"label":"Email"},{"label":"Message","style":"paragraph"}]}\' />',
    '<capability name="discord-ui" action="buttons" data=\'[{"label":"Yes","style":"success"},{"label":"No","style":"danger"},{"label":"Maybe","style":"secondary"}]\' />',
    '<capability name="discord-ui" action="select" data=\'{"placeholder":"Choose one...","options":[{"label":"Option 1","value":"1"},{"label":"Option 2","value":"2"}]}\' />',
    '<capability name="discord-ui" action="context-menu" data=\'{"name":"Analyze Message"}\' />',
  ],
  handler,
};

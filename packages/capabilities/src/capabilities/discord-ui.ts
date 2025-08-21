import { RegisteredCapability } from '../services/capability-registry.js';
import { logger } from '@coachartie/shared';
import { 
  ModalBuilder, 
  TextInputBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  SelectMenuBuilder,
  ContextMenuCommandBuilder,
  TextInputStyle,
  ButtonStyle,
  ApplicationCommandType
} from 'discord.js';

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
  options?: Array<{label: string, value: string, description?: string}>;
  buttons?: Array<{label: string, style?: string, customId?: string}>;
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
  const { action, title, customId, name, style, placeholder, options, buttons, inputs } = params;
  
  try {
    switch (action) {
      case 'modal':
        return await createModal(params, content);
        
      case 'buttons':
        return await createButtons(params, content);
        
      case 'select':
        return await createSelectMenu(params, content);
        
      case 'context-menu':
        return await createContextMenu(params, content);
        
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
    
  } catch (error) {
    logger.error('Discord UI capability error:', {
      action,
      error: error instanceof Error ? error.message : String(error),
      params
    });
    throw new Error(`Failed to create Discord UI component: ${error instanceof Error ? error.message : String(error)}`);
  }
};

async function createModal(params: DiscordUIParams, content?: string): Promise<string> {
  const modal = new ModalBuilder()
    .setCustomId(params.customId || `modal_${Date.now()}`)
    .setTitle(params.title || 'Form');

  // Parse inputs from params or content
  const inputs = params.inputs || parseInputsFromContent(content);
  
  if (!inputs || inputs.length === 0) {
    throw new Error('Modal requires at least one input field');
  }

  // Add up to 5 input fields (Discord limit)
  for (let i = 0; i < Math.min(inputs.length, 5); i++) {
    const input = inputs[i];
    const textInput = new TextInputBuilder()
      .setCustomId(input.customId || `input_${i}`)
      .setLabel(input.label)
      .setStyle(input.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short);
    
    if (input.placeholder) textInput.setPlaceholder(input.placeholder);
    if (input.required !== undefined) textInput.setRequired(input.required);
    if (input.minLength) textInput.setMinLength(input.minLength);
    if (input.maxLength) textInput.setMaxLength(input.maxLength);
    
    const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
    modal.addComponents(actionRow);
  }

  // Store modal for Discord to pick up (would need to integrate with message handler)
  const modalId = modal.data.custom_id;
  logger.info('🎨 Generated Discord modal:', { modalId, title: params.title, inputCount: inputs.length });
  
  // Return special response format that Discord consumer will recognize
  return `DISCORD_UI:MODAL:${JSON.stringify({
    modalId,
    modal: modal.toJSON(),
    title: params.title,
    inputCount: inputs.length
  })}:Modal "${params.title}" with ${inputs.length} input fields created! Waiting for user interaction...`;
}

async function createButtons(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.buttons || params.buttons.length === 0) {
    throw new Error('Button action requires buttons array');
  }

  const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons = params.buttons.slice(0, 25); // Discord limit: 25 buttons total
  
  // Discord allows max 5 buttons per row, max 5 rows
  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5);
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    
    rowButtons.forEach((btn, index) => {
      const button = new ButtonBuilder()
        .setCustomId(btn.customId || `btn_${i + index}`)
        .setLabel(btn.label)
        .setStyle(getButtonStyle(btn.style));
      
      actionRow.addComponents(button);
    });
    
    actionRows.push(actionRow);
  }

  logger.info('🔘 Generated Discord buttons:', { buttonCount: buttons.length, rows: actionRows.length });
  
  return `DISCORD_UI:BUTTONS:${JSON.stringify({
    actionRows: actionRows.map(row => row.toJSON()),
    buttonCount: buttons.length,
    rows: actionRows.length
  })}:Created ${buttons.length} interactive buttons! Click to interact.`;
}

async function createSelectMenu(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.options || params.options.length === 0) {
    throw new Error('Select menu requires options array');
  }

  const selectMenu = new SelectMenuBuilder()
    .setCustomId(params.customId || `select_${Date.now()}`)
    .setPlaceholder(params.placeholder || 'Choose an option...')
    .setMinValues(1)
    .setMaxValues(1);

  // Add options (max 25)
  const options = params.options.slice(0, 25).map(opt => ({
    label: opt.label,
    value: opt.value,
    description: opt.description
  }));

  selectMenu.addOptions(options);

  const actionRow = new ActionRowBuilder<SelectMenuBuilder>().addComponents(selectMenu);

  logger.info('📋 Generated Discord select menu:', { 
    customId: selectMenu.data.custom_id, 
    optionCount: options.length 
  });
  
  return `DISCORD_UI:SELECT:${JSON.stringify({
    actionRow: actionRow.toJSON(),
    customId: selectMenu.data.custom_id,
    optionCount: options.length
  })}:Select menu with ${options.length} options created! Choose an option to continue.`;
}

async function createContextMenu(params: DiscordUIParams, content?: string): Promise<string> {
  if (!params.name) {
    throw new Error('Context menu requires name parameter');
  }

  const contextMenu = new ContextMenuCommandBuilder()
    .setName(params.name)
    .setType(ApplicationCommandType.Message); // Can also be User or ChatInput

  logger.info('📝 Generated Discord context menu:', { name: params.name });
  
  return `DISCORD_UI:CONTEXT_MENU:${JSON.stringify({
    command: contextMenu.toJSON(),
    name: params.name
  })}:Context menu "${params.name}" created! This will be available when right-clicking messages.`;
}

// Helper functions
function parseInputsFromContent(content?: string): Array<any> {
  if (!content) return [];
  
  // Simple parsing - could be enhanced with XML parsing
  const lines = content.split('\n').filter(line => line.trim());
  return lines.map((line, index) => ({
    label: line.trim(),
    customId: `field_${index}`,
    style: 'short',
    required: true
  }));
}

function getButtonStyle(style?: string): ButtonStyle {
  switch (style?.toLowerCase()) {
    case 'primary': return ButtonStyle.Primary;
    case 'secondary': return ButtonStyle.Secondary;
    case 'success': return ButtonStyle.Success;
    case 'danger': return ButtonStyle.Danger;
    case 'link': return ButtonStyle.Link;
    default: return ButtonStyle.Secondary;
  }
}

export const discordUICapability: RegisteredCapability = {
  name: 'discord-ui',
  supportedActions: ['modal', 'buttons', 'select', 'context-menu'],
  description: 'Create interactive Discord UI components (modals, buttons, select menus, context menus)',
  requiredParams: ['action'],
  examples: [
    '<capability name="discord-ui" action="modal" title="User Feedback">Name\nEmail\nMessage</capability>',
    '<capability name="discord-ui" action="buttons" buttons=\'[{"label":"Yes","style":"success"},{"label":"No","style":"danger"}]\' />',
    '<capability name="discord-ui" action="select" options=\'[{"label":"Option 1","value":"1"},{"label":"Option 2","value":"2"}]\' placeholder="Choose one..." />',
    '<capability name="discord-ui" action="context-menu" name="Analyze Message" />'
  ],
  handler
};
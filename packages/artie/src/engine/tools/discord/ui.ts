import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { addPendingComponents } from '../../1-intake/pending-components.js';

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
  buttons?: Array<{ label: string; style?: string; customId?: string; url?: string }>;
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

const handler = async (
  params: DiscordUIParams,
  content?: string,
  context?: CapabilityContext
): Promise<string> => {
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
        return await createButtons(mergedParams, content, context);

      case 'select':
        return await createSelectMenu(mergedParams, content, context);

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
    const errorMsg = getErrorMessage(error);
    logger.error('Discord UI capability error:', {
      action,
      error: errorMsg,
      params,
      content,
    });
    throw new Error(`Failed to create Discord UI component: ${errorMsg}`);
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
    let style: number;
    if (input.style === 'paragraph') {
      style = TextInputStyle.Paragraph;
    } else {
      style = TextInputStyle.Short;
    }
    const textInput: any = {
      type: 4, // TextInput component type
      custom_id: input.customId || `input_${i}`,
      label: input.label,
      style,
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

  // Honest, not a success claim: a modal can only open in direct response to an
  // interaction (a button/select click or a slash command), never attached to a plain
  // chat reply — there is no interaction here for it to ride on.
  return `DISCORD_UI:MODAL:${JSON.stringify({
    modalId,
    modal: modalJson,
    title,
    inputCount: inputs.length,
  })}:I built a modal ("${title}", ${inputs.length} field${pluralSuffix(inputs.length)}), but modals can only open in direct response to a button, select menu, or slash command interaction — it can't appear on a plain chat reply like this one, so nothing will actually pop up for you here.`;
}

/** 's' unless count is exactly 1. No ternaries (ESLint no-ternary). */
function pluralSuffix(count: number): string {
  if (count === 1) {
    return '';
  }
  return 's';
}

// Discord hard limits for buttons: 5 action rows per message, 5 buttons per row.
const MAX_BUTTON_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTON_LABEL_LEN = 80;
const MAX_SELECT_OPTIONS = 25;
const ALLOWED_BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger', 'link']);

interface SanitizedButton {
  label: string;
  style: string;
  url?: string;
}

/** Validate + clamp a raw buttons array: drop entries that can't be made into a real button
 *  rather than throwing, so one bad entry doesn't sink the whole batch. */
function sanitizeButtons(raw: any[]): SanitizedButton[] {
  const out: SanitizedButton[] = [];
  for (const btn of raw) {
    if (!btn || typeof btn.label !== 'string' || !btn.label.trim()) continue;
    const label = btn.label.trim().slice(0, MAX_BUTTON_LABEL_LEN);
    let styleRaw: string;
    if (typeof btn.style === 'string') {
      styleRaw = btn.style.toLowerCase();
    } else {
      styleRaw = 'secondary';
    }
    let style: string;
    if (ALLOWED_BUTTON_STYLES.has(styleRaw)) {
      style = styleRaw;
    } else {
      style = 'secondary';
    }

    if (style === 'link') {
      // Link buttons carry a URL, never a custom_id, and only ever an http(s) URL.
      if (typeof btn.url !== 'string' || !/^https?:\/\//i.test(btn.url)) continue;
      out.push({ label, style, url: btn.url });
    } else {
      out.push({ label, style });
    }

    if (out.length >= MAX_BUTTON_ROWS * MAX_BUTTONS_PER_ROW) break;
  }
  return out;
}

/** Server-built custom_id: `artie:<shortTurnId>:<index>`. The model never supplies this. */
function artieCustomId(turnId: string, index: number): string {
  return `artie:${turnId.slice(-12)}:${index}`;
}

function buildButtonActionRows(buttons: SanitizedButton[], turnId: string): any[] {
  const rows: any[] = [];
  let index = 0;
  for (let i = 0; i < buttons.length && rows.length < MAX_BUTTON_ROWS; i += MAX_BUTTONS_PER_ROW) {
    const rowButtons = buttons.slice(i, i + MAX_BUTTONS_PER_ROW);
    const row = {
      type: 1, // ActionRow
      components: rowButtons.map((btn) => {
        const component: any = {
          type: 2, // Button
          label: btn.label,
          style: getButtonStyle(btn.style),
        };
        if (btn.style === 'link') {
          component.url = btn.url;
        } else {
          component.custom_id = artieCustomId(turnId, index);
        }
        index++;
        return component;
      }),
    };
    rows.push(row);
  }
  return rows;
}

/** The legacy push-worker path: no turn id, so the old inline DISCORD_UI marker is the only
 *  way these components can ever reach Discord. Unchanged behavior. */
async function createLegacyButtons(buttonsArray: any[]): Promise<string> {
  const actionRows: any[] = [];
  const buttons = buttonsArray.slice(0, 25); // Discord limit: 25 buttons total

  for (let i = 0; i < buttons.length; i += 5) {
    const rowButtons = buttons.slice(i, i + 5);
    const actionRow = {
      type: 1,
      components: [] as any[],
    };

    rowButtons.forEach((btn, index) => {
      actionRow.components.push({
        type: 2,
        custom_id: btn.customId || `btn_${i + index}`,
        label: btn.label,
        style: getButtonStyle(btn.style),
      });
    });

    actionRows.push(actionRow);
  }

  logger.info('🔘 Generated Discord buttons (legacy/no turn id):', {
    buttonCount: buttons.length,
    rows: actionRows.length,
  });

  return `DISCORD_UI:BUTTONS:${JSON.stringify({
    actionRows,
    buttonCount: buttons.length,
    rows: actionRows.length,
  })}:Created ${buttons.length} interactive buttons! Click to interact.`;
}

async function createButtons(
  params: DiscordUIParams,
  _content?: string,
  context?: CapabilityContext
): Promise<string> {
  // Extract buttons - handle both array format and object-with-numeric-keys
  const buttonsArray = extractButtonsArray(params);

  logger.debug('🔘 createButtons input:', {
    hasButtonsArray: !!params.buttons,
    hasNumericKeys: Object.keys(params).some((k) => !isNaN(parseInt(k, 10))),
    extractedCount: buttonsArray?.length || 0,
  });

  if (!buttonsArray || buttonsArray.length === 0) {
    throw new Error('Button action requires buttons array');
  }

  const turnId = context?.messageId;
  if (!turnId) {
    // No turn id means this call didn't come from a normal reply's tool loop (e.g. a
    // proactive push) — keep the old inline-marker behavior for push-worker.
    return createLegacyButtons(buttonsArray);
  }

  const buttons = sanitizeButtons(buttonsArray);
  if (buttons.length === 0) {
    throw new Error(
      'No valid buttons after validation: each needs a non-empty label (≤80 chars); ' +
        'link-style buttons also need an http(s) url and no custom_id.'
    );
  }

  const rows = buildButtonActionRows(buttons, turnId);
  addPendingComponents(turnId, rows);

  const labels = buttons.map((b) => b.label).join(' / ');
  logger.info('🔘 Queued Discord buttons for turn:', {
    turnId: turnId.slice(-8),
    count: buttons.length,
  });

  return `${buttons.length} button${pluralSuffix(buttons.length)} will appear under your reply: ${labels}`;
}

interface SanitizedOption {
  label: string;
  value: string;
  description?: string;
}

/** Validate + clamp a raw options array, dropping entries that can't be a real option. */
function sanitizeOptions(raw: any[]): SanitizedOption[] {
  const out: SanitizedOption[] = [];
  const seenValues = new Set<string>(); // Discord rejects a select with duplicate option values
  for (const opt of raw) {
    if (!opt || typeof opt.label !== 'string' || !opt.label.trim()) continue;
    const label = opt.label.trim().slice(0, 100);
    const value = String(opt.value ?? opt.label).slice(0, 100);
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    let description: string | undefined;
    if (typeof opt.description === 'string' && opt.description.trim()) {
      description = opt.description.slice(0, 100);
    }
    out.push({ label, value, description });
    if (out.length >= MAX_SELECT_OPTIONS) break;
  }
  return out;
}

/** The legacy push-worker path: no turn id. Unchanged behavior. */
async function createLegacySelectMenu(optionsArray: any[], params: DiscordUIParams): Promise<string> {
  const customId = params.customId || `select_${Date.now()}`;
  const placeholder = params.placeholder || 'Choose an option...';

  const options = optionsArray.slice(0, 25).map((opt) => ({
    label: opt.label,
    value: opt.value,
    description: opt.description,
  }));

  const selectMenu = {
    type: 3,
    custom_id: customId,
    placeholder,
    min_values: 1,
    max_values: 1,
    options,
  };

  const actionRow = {
    type: 1,
    components: [selectMenu],
  };

  logger.info('📋 Generated Discord select menu (legacy/no turn id):', {
    customId,
    optionCount: options.length,
  });

  return `DISCORD_UI:SELECT:${JSON.stringify({
    actionRow,
    customId,
    optionCount: options.length,
  })}:Select menu with ${options.length} options created! Choose an option to continue.`;
}

async function createSelectMenu(
  params: DiscordUIParams,
  _content?: string,
  context?: CapabilityContext
): Promise<string> {
  // Extract options - handle both array format and object-with-numeric-keys
  const optionsArray = extractOptionsArray(params);

  if (!optionsArray || optionsArray.length === 0) {
    throw new Error('Select menu requires options array');
  }

  const turnId = context?.messageId;
  if (!turnId) {
    return createLegacySelectMenu(optionsArray, params);
  }

  const options = sanitizeOptions(optionsArray);
  if (options.length === 0) {
    throw new Error('No valid options after validation: each needs a non-empty label.');
  }

  const placeholder = (params.placeholder || 'Choose an option...').slice(0, 150);
  const row = {
    type: 1, // ActionRow
    components: [
      {
        type: 3, // StringSelectMenu
        custom_id: artieCustomId(turnId, 0),
        placeholder,
        min_values: 1,
        max_values: 1,
        options,
      },
    ],
  };

  addPendingComponents(turnId, [row]);

  logger.info('📋 Queued Discord select menu for turn:', {
    turnId: turnId.slice(-8),
    optionCount: options.length,
  });

  return `A dropdown with ${options.length} option${pluralSuffix(options.length)} will appear under your reply: ${options.map((o) => o.label).join(', ')}`;
}

async function createContextMenu(params: DiscordUIParams, _content?: string): Promise<string> {
  if (!params.name) {
    throw new Error('Context menu requires name parameter');
  }

  const contextMenu = {
    name: params.name,
    type: ApplicationCommandType.Message, // Can also be User or ChatInput
  };

  logger.info('📝 Generated Discord context menu:', { name: params.name });

  // Honest, not a success claim: a context menu is a Discord application command and
  // only actually appears after it's registered with Discord's API — building the JSON here
  // doesn't register anything, so right-clicking a message won't show it yet.
  return `DISCORD_UI:CONTEXT_MENU:${JSON.stringify({
    command: contextMenu,
    name: params.name,
  })}:I built a context menu command ("${params.name}"), but it needs to be registered with Discord before it shows up when right-clicking a message — that hasn't happened here, so nothing changed for you yet.`;
}

// Helper functions

/**
 * Convert object with numeric keys to array
 * The LLM sometimes generates params like {"0":{...},"1":{...}} instead of [{...},{...}]
 */
function objectWithNumericKeysToArray(obj: any): any[] | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null;
  }

  // Check if object has numeric keys (0, 1, 2, etc.)
  const keys = Object.keys(obj).filter((k) => !isNaN(parseInt(k, 10)));
  if (keys.length === 0) {
    return null;
  }

  // Sort keys numerically and extract values
  const sortedKeys = keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return sortedKeys.map((k) => obj[k]);
}

/**
 * Extract buttons array from params that might have numeric keys
 */
function extractButtonsArray(params: any): any[] | undefined {
  // If buttons array exists, use it
  if (params.buttons && Array.isArray(params.buttons)) {
    return params.buttons;
  }

  // Try to convert numeric keys to array
  const fromNumericKeys = objectWithNumericKeysToArray(params);
  if (fromNumericKeys && fromNumericKeys.length > 0) {
    // Verify these look like button objects
    if (fromNumericKeys[0] && typeof fromNumericKeys[0].label === 'string') {
      return fromNumericKeys;
    }
  }

  return undefined;
}

/**
 * Extract options array from params that might have numeric keys
 */
function extractOptionsArray(params: any): any[] | undefined {
  // If options array exists, use it
  if (params.options && Array.isArray(params.options)) {
    return params.options;
  }

  // Try to convert numeric keys to array
  const fromNumericKeys = objectWithNumericKeysToArray(params);
  if (fromNumericKeys && fromNumericKeys.length > 0) {
    // Verify these look like option objects
    if (fromNumericKeys[0] && typeof fromNumericKeys[0].label === 'string') {
      return fromNumericKeys;
    }
  }

  return undefined;
}

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
  emoji: '🎨',
  supportedActions: ['modal', 'buttons', 'select', 'context-menu'],
  description:
    'Create interactive Discord UI components. buttons/select attach under THIS reply automatically ' +
    "(no separate send needed) — a click comes back to you as a new turn describing who picked what. " +
    'modal/context-menu need a live interaction to open and cannot attach to a plain reply.',
  requiredParams: [], // action is automatically injected by capability registry
  examples: [
    '<capability name="discord-ui" action="modal" data=\'{"title":"User Feedback","inputs":[{"label":"Name","required":true},{"label":"Email"},{"label":"Message","style":"paragraph"}]}\' />',
    '<capability name="discord-ui" action="buttons" data=\'[{"label":"Yes","style":"success"},{"label":"No","style":"danger"},{"label":"Maybe","style":"secondary"}]\' />',
    '<capability name="discord-ui" action="select" data=\'{"placeholder":"Choose one...","options":[{"label":"Option 1","value":"1"},{"label":"Option 2","value":"2"}]}\' />',
    '<capability name="discord-ui" action="context-menu" data=\'{"name":"Analyze Message"}\' />',
  ],
  handler,
};

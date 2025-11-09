#!/usr/bin/env tsx
/**
 * Prompt Database TUI
 *
 * Interactive terminal UI for viewing and editing prompts
 * Works for both AI and human use
 */

import blessed from 'blessed';
import {
  promptManager,
  PromptTemplate,
} from '../packages/capabilities/src/services/prompt-manager.js';

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Coach Artie - Prompt Database',
  fullUnicode: true,
});

// Main container
const container = blessed.box({
  parent: screen,
  width: '100%',
  height: '100%',
  style: {
    bg: 'black',
  },
});

// Header
const header = blessed.box({
  parent: container,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  content:
    '{bold}{cyan-fg}🤖 COACH ARTIE - PROMPT DATABASE{/cyan-fg}{/bold}\nPress {yellow-fg}?{/yellow-fg} for help, {yellow-fg}q{/yellow-fg} to quit',
  tags: true,
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'cyan',
    },
  },
});

// Prompt list (left panel)
const promptList = blessed.list({
  parent: container,
  label: ' {bold}{cyan-fg}Prompts{/cyan-fg}{/bold} ',
  tags: true,
  top: 3,
  left: 0,
  width: '30%',
  height: '60%-3',
  keys: true,
  vi: true,
  mouse: true,
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'yellow',
    },
    selected: {
      bg: 'blue',
      fg: 'white',
      bold: true,
    },
    item: {
      fg: 'white',
    },
  },
  scrollbar: {
    ch: '█',
    style: {
      fg: 'cyan',
    },
  },
});

// Prompt details (right panel)
const promptDetails = blessed.box({
  parent: container,
  label: ' {bold}{cyan-fg}Details{/cyan-fg}{/bold} ',
  tags: true,
  top: 3,
  left: '30%',
  width: '70%',
  height: '60%-3',
  scrollable: true,
  keys: true,
  vi: true,
  mouse: true,
  scrollbar: {
    ch: '█',
    style: {
      fg: 'cyan',
    },
  },
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'yellow',
    },
  },
});

// Status bar
const statusBar = blessed.box({
  parent: container,
  bottom: 10,
  left: 0,
  width: '100%',
  height: 3,
  content: 'Loading prompts...',
  tags: true,
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'green',
    },
  },
});

// Command log (bottom panel)
const commandLog = blessed.log({
  parent: container,
  label: ' {bold}{cyan-fg}Log{/cyan-fg}{/bold} ',
  tags: true,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 10,
  scrollable: true,
  scrollbar: {
    ch: '█',
    style: {
      fg: 'cyan',
    },
  },
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'green',
    },
  },
});

// State
let currentPrompts: PromptTemplate[] = [];
let selectedPrompt: PromptTemplate | null = null;

// Logging helper
function log(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
  const colors = {
    info: 'white',
    success: 'green',
    error: 'red',
    warn: 'yellow',
  };
  const timestamp = new Date().toLocaleTimeString();
  commandLog.log(`{${colors[type]}-fg}[${timestamp}] ${message}{/${colors[type]}-fg}`);
  screen.render();
}

// Load prompts
async function loadPrompts(category?: string) {
  try {
    log('Loading prompts from database...', 'info');
    currentPrompts = await promptManager.listPrompts(category);

    const items = currentPrompts.map((p) => {
      const activeIndicator = p.isActive ? '✓' : '✗';
      const versionInfo = `v${p.version}`;
      return `${activeIndicator} {bold}${p.name}{/bold} ${versionInfo} ({cyan-fg}${p.category}{/cyan-fg})`;
    });

    promptList.setItems(items);
    statusBar.setContent(`{green-fg}Loaded ${currentPrompts.length} prompts{/green-fg}`);
    log(`Successfully loaded ${currentPrompts.length} prompts`, 'success');
    screen.render();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    statusBar.setContent(`{red-fg}Error: ${errorMsg}{/red-fg}`);
    log(`Failed to load prompts: ${errorMsg}`, 'error');
    screen.render();
  }
}

// Show prompt details
function showPromptDetails(prompt: PromptTemplate) {
  selectedPrompt = prompt;

  const content = `
{bold}{yellow-fg}Name:{/yellow-fg}{/bold} ${prompt.name}
{bold}{yellow-fg}Version:{/yellow-fg}{/bold} ${prompt.version}
{bold}{yellow-fg}Category:{/yellow-fg}{/bold} ${prompt.category}
{bold}{yellow-fg}Active:{/yellow-fg}{/bold} ${prompt.isActive ? '{green-fg}Yes{/green-fg}' : '{red-fg}No{/red-fg}'}
{bold}{yellow-fg}Description:{/yellow-fg}{/bold} ${prompt.description || 'N/A'}
{bold}{yellow-fg}Created:{/yellow-fg}{/bold} ${prompt.createdAt}
{bold}{yellow-fg}Updated:{/yellow-fg}{/bold} ${prompt.updatedAt}

{bold}{cyan-fg}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}{/bold}
{bold}{yellow-fg}Content:{/yellow-fg}{/bold}
{bold}{cyan-fg}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}{/bold}

${prompt.content}

{bold}{cyan-fg}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}{/bold}
{bold}{yellow-fg}Metadata:{/yellow-fg}{/bold}
${JSON.stringify(prompt.metadata, null, 2)}
  `.trim();

  promptDetails.setContent(content);
  log(`Viewing prompt: ${prompt.name} (v${prompt.version})`, 'info');
  screen.render();
}

// Edit prompt
function editPrompt(prompt: PromptTemplate) {
  const form = blessed.form({
    parent: screen,
    keys: true,
    left: 'center',
    top: 'center',
    width: '80%',
    height: '80%',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
    label: ' {bold}Edit Prompt{/bold} ',
  });

  const textarea = blessed.textarea({
    parent: form,
    mouse: true,
    keys: true,
    vi: true,
    top: 1,
    left: 1,
    width: '100%-2',
    height: '100%-6',
    value: prompt.content,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'yellow',
      },
      focus: {
        border: {
          fg: 'green',
        },
      },
    },
  });

  const instructions = blessed.box({
    parent: form,
    bottom: 3,
    left: 1,
    width: '100%-2',
    height: 1,
    content: '{yellow-fg}Ctrl+S to save, Escape to cancel{/yellow-fg}',
    tags: true,
  });

  const submitButton = blessed.button({
    parent: form,
    mouse: true,
    keys: true,
    shrink: true,
    bottom: 1,
    left: 'center',
    name: 'submit',
    content: ' Save (Ctrl+S) ',
    style: {
      bg: 'green',
      fg: 'white',
      focus: {
        bg: 'white',
        fg: 'green',
      },
    },
  });

  textarea.focus();

  // Save handler
  const saveContent = async () => {
    const newContent = textarea.getValue();
    try {
      form.destroy();
      log(`Saving changes to ${prompt.name}...`, 'info');

      await promptManager.updatePrompt(prompt.name, newContent, 'tui-user', 'Edited via TUI');

      log(`Successfully updated ${prompt.name}`, 'success');
      statusBar.setContent(`{green-fg}✓ Prompt updated successfully{/green-fg}`);

      // Reload prompts
      await loadPrompts();

      // Find and re-select the updated prompt
      const updatedPrompt = currentPrompts.find((p) => p.name === prompt.name);
      if (updatedPrompt) {
        showPromptDetails(updatedPrompt);
      }

      screen.render();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Failed to update prompt: ${errorMsg}`, 'error');
      statusBar.setContent(`{red-fg}Error: ${errorMsg}{/red-fg}`);
      screen.render();
    }
  };

  // Key bindings
  textarea.key(['C-s'], saveContent);
  submitButton.on('press', saveContent);

  form.key(['escape'], () => {
    form.destroy();
    log('Edit cancelled', 'warn');
    screen.render();
  });

  screen.render();
}

// Show help
function showHelp() {
  const helpBox = blessed.box({
    parent: screen,
    left: 'center',
    top: 'center',
    width: '60%',
    height: '70%',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
    label: ' {bold}{cyan-fg}Help{/cyan-fg}{/bold} ',
    tags: true,
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    content: `
{bold}{yellow-fg}Navigation:{/yellow-fg}{/bold}
  {cyan-fg}↑/k{/cyan-fg}       Move up
  {cyan-fg}↓/j{/cyan-fg}       Move down
  {cyan-fg}Tab{/cyan-fg}       Switch panel
  {cyan-fg}Enter{/cyan-fg}     View prompt details

{bold}{yellow-fg}Actions:{/yellow-fg}{/bold}
  {cyan-fg}e{/cyan-fg}         Edit selected prompt
  {cyan-fg}h{/cyan-fg}         View prompt history
  {cyan-fg}n{/cyan-fg}         Create new prompt
  {cyan-fg}t{/cyan-fg}         Toggle active status
  {cyan-fg}r{/cyan-fg}         Refresh list
  {cyan-fg}c{/cyan-fg}         Clear cache

{bold}{yellow-fg}Filtering:{/yellow-fg}{/bold}
  {cyan-fg}f{/cyan-fg}         Filter by category
  {cyan-fg}a{/cyan-fg}         Show all prompts

{bold}{yellow-fg}Other:{/yellow-fg}{/bold}
  {cyan-fg}?{/cyan-fg}         Show this help
  {cyan-fg}q{/cyan-fg}         Quit

{bold}{yellow-fg}Editing:{/yellow-fg}{/bold}
  {cyan-fg}Ctrl+S{/cyan-fg}   Save changes
  {cyan-fg}Escape{/cyan-fg}    Cancel

Press any key to close this help...
    `.trim(),
  });

  helpBox.key(['escape', 'enter', 'q', '?'], () => {
    helpBox.destroy();
    screen.render();
  });

  helpBox.focus();
  screen.render();
}

// View prompt history
async function viewHistory(prompt: PromptTemplate) {
  try {
    log(`Loading history for ${prompt.name}...`, 'info');
    const history = await promptManager.getPromptHistory(prompt.name);

    const historyBox = blessed.list({
      parent: screen,
      label: ` {bold}History: ${prompt.name}{/bold} `,
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      left: 'center',
      top: 'center',
      width: '80%',
      height: '80%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
        selected: {
          bg: 'blue',
          fg: 'white',
        },
      },
      items: history.map((h) => {
        return `v${h.version} - {cyan-fg}${h.updatedAt}{/cyan-fg} - ${h.description || 'No description'}`;
      }),
    });

    historyBox.key(['escape', 'q'], () => {
      historyBox.destroy();
      screen.render();
    });

    historyBox.on('select', (item, index) => {
      const selectedHistory = history[index];
      showPromptDetails(selectedHistory);
      historyBox.destroy();
      screen.render();
    });

    historyBox.focus();
    log(`Loaded ${history.length} versions`, 'success');
    screen.render();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Failed to load history: ${errorMsg}`, 'error');
  }
}

// Key bindings
screen.key(['q', 'C-c'], () => {
  log('Shutting down...', 'info');
  return process.exit(0);
});

screen.key(['?'], () => {
  showHelp();
});

screen.key(['r'], async () => {
  await loadPrompts();
});

screen.key(['c'], () => {
  promptManager.clearCache();
  log('Cache cleared', 'success');
  statusBar.setContent('{green-fg}✓ Cache cleared{/green-fg}');
  screen.render();
});

screen.key(['tab'], () => {
  if (promptList.focused) {
    promptDetails.focus();
  } else {
    promptList.focus();
  }
  screen.render();
});

// Prompt list handlers
promptList.on('select', (item, index) => {
  const prompt = currentPrompts[index];
  if (prompt) {
    showPromptDetails(prompt);
  }
});

promptList.key(['e'], () => {
  if (selectedPrompt) {
    editPrompt(selectedPrompt);
  } else {
    log('No prompt selected', 'warn');
  }
});

promptList.key(['h'], async () => {
  if (selectedPrompt) {
    await viewHistory(selectedPrompt);
  } else {
    log('No prompt selected', 'warn');
  }
});

promptList.key(['t'], async () => {
  if (selectedPrompt) {
    try {
      const newActiveState = !selectedPrompt.isActive;
      log(`Toggling active status for ${selectedPrompt.name}...`, 'info');

      // Update via database
      const { getDatabase } = await import('../packages/shared/src/utils/database.js');
      const db = await getDatabase();
      await db.run('UPDATE prompts SET is_active = ? WHERE name = ?', [
        newActiveState ? 1 : 0,
        selectedPrompt.name,
      ]);

      log(`${selectedPrompt.name} is now ${newActiveState ? 'active' : 'inactive'}`, 'success');
      await loadPrompts();
      screen.render();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Failed to toggle status: ${errorMsg}`, 'error');
    }
  } else {
    log('No prompt selected', 'warn');
  }
});

// Focus prompt list by default
promptList.focus();

// Initial load
(async () => {
  await loadPrompts();
  screen.render();
})();

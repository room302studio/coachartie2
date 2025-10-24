#!/usr/bin/env tsx
/**
 * Prompt Database CLI
 *
 * Programmatic interface for AI and scripting
 * Usage:
 *   prompt-cli list [category]
 *   prompt-cli view <name>
 *   prompt-cli edit <name>
 *   prompt-cli create <name> <category>
 *   prompt-cli history <name>
 *   prompt-cli toggle <name>
 *   prompt-cli export [name]
 *   prompt-cli import <file>
 */

import { promptManager, PromptTemplate } from '../packages/capabilities/src/services/prompt-manager.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const command = process.argv[2];
const args = process.argv.slice(3);

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function log(message: string, color = 'white') {
  console.log(`${colors[color as keyof typeof colors]}${message}${colors.reset}`);
}

function error(message: string) {
  log(`❌ Error: ${message}`, 'red');
  process.exit(1);
}

function success(message: string) {
  log(`✅ ${message}`, 'green');
}

function info(message: string) {
  log(`ℹ️  ${message}`, 'cyan');
}

// List prompts
async function listPrompts(category?: string) {
  const prompts = await promptManager.listPrompts(category);

  if (prompts.length === 0) {
    info('No prompts found');
    return;
  }

  log(`\n${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  log(`${colors.bright}PROMPTS${category ? ` (Category: ${category})` : ''}${colors.reset}`, 'cyan');
  log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  for (const prompt of prompts) {
    const activeIndicator = prompt.isActive
      ? `${colors.green}✓${colors.reset}`
      : `${colors.red}✗${colors.reset}`;
    const name = `${colors.bright}${prompt.name}${colors.reset}`;
    const version = `${colors.yellow}v${prompt.version}${colors.reset}`;
    const category = `${colors.cyan}${prompt.category}${colors.reset}`;

    console.log(
      `${activeIndicator} ${name} ${version} (${category}) - ${prompt.description || 'No description'}`
    );
  }

  log(`\n${colors.cyan}Total: ${prompts.length} prompts${colors.reset}\n`);
}

// View prompt details
async function viewPrompt(name: string) {
  const prompt = await promptManager.getPrompt(name);

  if (!prompt) {
    error(`Prompt '${name}' not found`);
    return;
  }

  log(`\n${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  log(`${colors.bright}PROMPT: ${prompt.name}${colors.reset}`, 'cyan');
  log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  log(`${colors.yellow}Version:${colors.reset}     ${prompt.version}`);
  log(`${colors.yellow}Category:${colors.reset}    ${prompt.category}`);
  log(
    `${colors.yellow}Active:${colors.reset}      ${prompt.isActive ? `${colors.green}Yes${colors.reset}` : `${colors.red}No${colors.reset}`}`
  );
  log(`${colors.yellow}Description:${colors.reset} ${prompt.description || 'N/A'}`);
  log(`${colors.yellow}Created:${colors.reset}     ${prompt.createdAt}`);
  log(`${colors.yellow}Updated:${colors.reset}     ${prompt.updatedAt}`);

  log(`\n${colors.bright}${colors.yellow}Content:${colors.reset}`);
  log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(prompt.content);
  log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  if (Object.keys(prompt.metadata).length > 0) {
    log(`${colors.yellow}Metadata:${colors.reset}`);
    console.log(JSON.stringify(prompt.metadata, null, 2));
  }
}

// Edit prompt (opens in $EDITOR)
async function editPrompt(name: string) {
  const prompt = await promptManager.getPrompt(name);

  if (!prompt) {
    error(`Prompt '${name}' not found`);
    return;
  }

  const tempFile = path.join('/tmp', `prompt-${name}-${Date.now()}.txt`);

  // Write current content to temp file
  await fs.writeFile(tempFile, prompt.content, 'utf-8');

  // Get editor from environment
  const editor = process.env.EDITOR || 'vim';

  info(`Opening ${name} in ${editor}...`);

  // Open editor
  const { spawn } = await import('child_process');
  const child = spawn(editor, [tempFile], {
    stdio: 'inherit',
  });

  child.on('exit', async (code) => {
    if (code === 0) {
      // Read updated content
      const newContent = await fs.readFile(tempFile, 'utf-8');

      if (newContent.trim() === prompt.content.trim()) {
        info('No changes detected');
      } else {
        await promptManager.updatePrompt(name, newContent, 'cli-user', 'Edited via CLI');
        success(`Updated ${name}`);
      }
    } else {
      error('Editor exited with error');
    }

    // Clean up temp file
    await fs.unlink(tempFile);
  });
}

// View prompt history
async function viewHistory(name: string) {
  const history = await promptManager.getPromptHistory(name);

  if (history.length === 0) {
    info(`No history found for '${name}'`);
    return;
  }

  log(`\n${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  log(`${colors.bright}HISTORY: ${name}${colors.reset}`, 'cyan');
  log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  for (const version of history) {
    const versionNum = `${colors.yellow}v${version.version}${colors.reset}`;
    const date = `${colors.cyan}${version.updatedAt}${colors.reset}`;
    const desc = version.description || 'No description';

    console.log(`${versionNum} - ${date} - ${desc}`);
  }

  log(`\n${colors.cyan}Total: ${history.length} versions${colors.reset}\n`);
}

// Toggle active status
async function toggleActive(name: string) {
  const prompt = await promptManager.getPrompt(name);

  if (!prompt) {
    error(`Prompt '${name}' not found`);
    return;
  }

  const { getDatabase } = await import('../packages/shared/src/utils/database.js');
  const db = await getDatabase();

  const newStatus = !prompt.isActive;
  await db.run('UPDATE prompts SET is_active = ? WHERE name = ?', [newStatus ? 1 : 0, name]);

  success(`${name} is now ${newStatus ? 'active' : 'inactive'}`);
}

// Export prompts
async function exportPrompts(name?: string) {
  const prompts = name
    ? [await promptManager.getPrompt(name)]
    : await promptManager.listPrompts();

  const filtered = prompts.filter((p): p is PromptTemplate => p !== null);

  if (filtered.length === 0) {
    error('No prompts to export');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = name
    ? `prompt-${name}-${timestamp}.json`
    : `prompts-export-${timestamp}.json`;

  await fs.writeFile(filename, JSON.stringify(filtered, null, 2), 'utf-8');

  success(`Exported ${filtered.length} prompt(s) to ${filename}`);
}

// Import prompts
async function importPrompts(file: string) {
  const content = await fs.readFile(file, 'utf-8');
  const prompts: PromptTemplate[] = JSON.parse(content);

  if (!Array.isArray(prompts)) {
    error('Invalid import file format (must be array of prompts)');
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const prompt of prompts) {
    try {
      // Check if prompt exists
      const existing = await promptManager.getPrompt(prompt.name);

      if (existing) {
        info(`Updating existing prompt: ${prompt.name}`);
        await promptManager.updatePrompt(
          prompt.name,
          prompt.content,
          'cli-import',
          'Imported from file'
        );
      } else {
        info(`Creating new prompt: ${prompt.name}`);
        await promptManager.createPrompt({
          name: prompt.name,
          content: prompt.content,
          description: prompt.description,
          category: prompt.category,
          isActive: prompt.isActive,
          metadata: prompt.metadata,
        });
      }

      imported++;
    } catch (error) {
      log(`Failed to import ${prompt.name}: ${error}`, 'red');
      skipped++;
    }
  }

  success(`Imported ${imported} prompts (${skipped} skipped)`);
}

// Create new prompt
async function createPrompt(name: string, category: string) {
  const tempFile = path.join('/tmp', `prompt-new-${Date.now()}.txt`);

  // Create template
  const template = `# New prompt: ${name}
# Category: ${category}
# Description: Enter prompt content below

Your prompt content here...
`;

  await fs.writeFile(tempFile, template, 'utf-8');

  const editor = process.env.EDITOR || 'vim';
  info(`Creating ${name} in ${editor}...`);

  const { spawn } = await import('child_process');
  const child = spawn(editor, [tempFile], {
    stdio: 'inherit',
  });

  child.on('exit', async (code) => {
    if (code === 0) {
      const content = await fs.readFile(tempFile, 'utf-8');

      // Remove template comments
      const cleanContent = content
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim();

      if (!cleanContent) {
        error('No content provided');
        await fs.unlink(tempFile);
        return;
      }

      await promptManager.createPrompt({
        name,
        category,
        content: cleanContent,
        isActive: true,
        metadata: {},
      });

      success(`Created prompt: ${name}`);
    } else {
      error('Editor exited with error');
    }

    await fs.unlink(tempFile);
  });
}

// Show usage
function showUsage() {
  log(`
${colors.bright}${colors.cyan}🤖 Coach Artie - Prompt Database CLI${colors.reset}

${colors.bright}Usage:${colors.reset}
  ${colors.yellow}prompt-cli${colors.reset} ${colors.green}<command>${colors.reset} ${colors.blue}[args]${colors.reset}

${colors.bright}Commands:${colors.reset}
  ${colors.green}list${colors.reset} ${colors.blue}[category]${colors.reset}     List all prompts (optionally filtered by category)
  ${colors.green}view${colors.reset} ${colors.blue}<name>${colors.reset}          View prompt details
  ${colors.green}edit${colors.reset} ${colors.blue}<name>${colors.reset}          Edit prompt in $EDITOR
  ${colors.green}create${colors.reset} ${colors.blue}<name> <cat>${colors.reset}  Create new prompt
  ${colors.green}history${colors.reset} ${colors.blue}<name>${colors.reset}       View prompt version history
  ${colors.green}toggle${colors.reset} ${colors.blue}<name>${colors.reset}        Toggle active status
  ${colors.green}export${colors.reset} ${colors.blue}[name]${colors.reset}        Export prompt(s) to JSON
  ${colors.green}import${colors.reset} ${colors.blue}<file>${colors.reset}        Import prompts from JSON
  ${colors.green}help${colors.reset}                  Show this help

${colors.bright}Examples:${colors.reset}
  ${colors.yellow}prompt-cli${colors.reset} list
  ${colors.yellow}prompt-cli${colors.reset} list system
  ${colors.yellow}prompt-cli${colors.reset} view PROMPT_SYSTEM
  ${colors.yellow}prompt-cli${colors.reset} edit PROMPT_SYSTEM
  ${colors.yellow}prompt-cli${colors.reset} create my-prompt system
  ${colors.yellow}prompt-cli${colors.reset} export PROMPT_SYSTEM
  ${colors.yellow}prompt-cli${colors.reset} import prompts.json

${colors.bright}AI Usage:${colors.reset}
  The CLI can be used programmatically for automated prompt management.
  All commands return proper exit codes and JSON-friendly output.
`, 'white');
}

// Main execution
(async () => {
  try {
    switch (command) {
      case 'list':
        await listPrompts(args[0]);
        break;

      case 'view':
        if (!args[0]) error('Usage: prompt-cli view <name>');
        await viewPrompt(args[0]);
        break;

      case 'edit':
        if (!args[0]) error('Usage: prompt-cli edit <name>');
        await editPrompt(args[0]);
        break;

      case 'create':
        if (!args[0] || !args[1]) error('Usage: prompt-cli create <name> <category>');
        await createPrompt(args[0], args[1]);
        break;

      case 'history':
        if (!args[0]) error('Usage: prompt-cli history <name>');
        await viewHistory(args[0]);
        break;

      case 'toggle':
        if (!args[0]) error('Usage: prompt-cli toggle <name>');
        await toggleActive(args[0]);
        break;

      case 'export':
        await exportPrompts(args[0]);
        break;

      case 'import':
        if (!args[0]) error('Usage: prompt-cli import <file>');
        await importPrompts(args[0]);
        break;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        showUsage();
        break;

      default:
        error(`Unknown command: ${command}\n`);
        showUsage();
        process.exit(1);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
})();

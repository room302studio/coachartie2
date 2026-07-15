import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { REST, Routes } from 'discord.js';
import { statusCommand } from './src/commands/status.js';
import { botStatusCommand } from './src/commands/bot-status.js';
import { modelsCommand } from './src/commands/models.js';
import { memoryCommand } from './src/commands/memory.js';
import { usageCommand } from './src/commands/usage.js';
import { debugCommand } from './src/commands/debug.js';
import { data as syncDiscussionsData } from './src/commands/sync-discussions.js';
import { watchRepoCommand } from './src/commands/watch-repo.js';
import { unwatchRepoCommand } from './src/commands/unwatch-repo.js';
import { listWatchesCommand } from './src/commands/list-watches.js';

const commands = [
  statusCommand.data.toJSON(),
  botStatusCommand.data.toJSON(),
  modelsCommand.data.toJSON(),
  memoryCommand.data.toJSON(),
  usageCommand.data.toJSON(),
  debugCommand.data.toJSON(),
  syncDiscussionsData.toJSON(),
  watchRepoCommand.data.toJSON(),
  unwatchRepoCommand.data.toJSON(),
  listWatchesCommand.data.toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

async function registerCommands() {
  try {
    console.log('🚀 Started refreshing Discord application (/) commands...');

    // Register commands globally
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });

    console.log('✅ Successfully reloaded Discord application (/) commands!');
    console.log('📱 Registered commands:');
    console.log('  - /link-phone - Link phone number for SMS notifications');
    console.log('  - /verify-phone - Verify phone number with code');
    console.log('  - /unlink-phone - Remove linked phone number');
    console.log('  - /link-email - Link email address for email features');
    console.log('  - /unlink-email - Remove linked email address');
    console.log('  - /status - Show LLM model used for most recent message');
    console.log('  - /bot-status - Check bot health and system status');
    console.log('  - /models - List available AI models');
    console.log('  - /memory - Search and manage conversation memories');
    console.log('  - /usage - View AI usage statistics and costs');
    console.log('  - /debug - Troubleshoot connection and performance issues');
    console.log('  - /sync-discussions - Sync Discord forum discussions to GitHub issues');
    console.log('  - /watch-repo - Watch a GitHub repo for PR and CI activity');
    console.log('  - /unwatch-repo - Stop watching a GitHub repo');
    console.log('  - /list-watches - List all watched GitHub repos');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

registerCommands();

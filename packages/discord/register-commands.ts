import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { REST, Routes } from 'discord.js';
import { linkPhoneCommand } from './src/commands/link-phone.js';
import { verifyPhoneCommand } from './src/commands/verify-phone.js';
import { unlinkPhoneCommand } from './src/commands/unlink-phone.js';
import { statusCommand } from './src/commands/status.js';

const commands = [
  linkPhoneCommand.data.toJSON(),
  verifyPhoneCommand.data.toJSON(),
  unlinkPhoneCommand.data.toJSON(),
  statusCommand.data.toJSON()
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

async function registerCommands() {
  try {
    console.log('🚀 Started refreshing Discord application (/) commands...');

    // Register commands globally
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
      { body: commands }
    );

    console.log('✅ Successfully reloaded Discord application (/) commands!');
    console.log('📱 Registered commands:');
    console.log('  - /link-phone - Link phone number for SMS notifications');
    console.log('  - /verify-phone - Verify phone number with code');
    console.log('  - /unlink-phone - Remove linked phone number');
    console.log('  - /status - Show LLM model used for most recent message');
    
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

registerCommands();
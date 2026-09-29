import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { REST, Routes } from 'discord.js';
import { stackTalkCommand } from './src/commands/stack-talk.js';

/**
 * Registers ONLY /stack-talk, as a guild command in Room 302 (STACK_TALK_GUILD_ID overrides).
 * POSTing one guild command creates or updates just that command. register-commands.ts PUTs
 * the whole global list, which would also add/remove other commands (as of 2026-09-29 the
 * live global set is out of date with that file), so it is deliberately not used here.
 */
const ROOM_302_GUILD_ID = '932719842522443928';
const guildId = process.env.STACK_TALK_GUILD_ID || ROOM_302_GUILD_ID;
const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

rest
  .post(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, guildId), {
    body: stackTalkCommand.data.toJSON(),
  })
  .then(() => console.log(`✅ /stack-talk registered in guild ${guildId}`))
  .catch((error) => {
    console.error('❌ Failed to register /stack-talk:', error);
    process.exit(1);
  });

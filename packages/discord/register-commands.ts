import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { REST, Routes } from 'discord.js';
import { globalCommands } from './src/commands/registry.js';

/**
 * Publish Artie's global slash commands from src/commands/registry.ts (the same list the
 * interaction handler routes from). This REPLACES the whole global set, so it prints the diff
 * against what Discord has first. `--dry-run` stops there.
 *
 *   npx tsx packages/discord/register-commands.ts --dry-run
 *   npx tsx packages/discord/register-commands.ts
 *
 * Guild-only commands (/stack-talk → register-stack-talk.ts) are unaffected.
 */
const dryRun = process.argv.includes('--dry-run');
const appId = process.env.DISCORD_CLIENT_ID!;
const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
const body = globalCommands.map((c) => c.data.toJSON());

async function main() {
  const live = (await rest.get(Routes.applicationCommands(appId))) as Array<{ name: string }>;
  const liveNames = new Set(live.map((c) => c.name));
  const wanted = new Set(body.map((c) => c.name));

  console.log(`Discord has ${live.length} global commands; registry has ${body.length}.`);
  for (const c of body) {
    const perms = c.default_member_permissions ? ` (default perms ${c.default_member_permissions})` : '';
    console.log(`  ${liveNames.has(c.name) ? '~' : '+'} /${c.name}${perms}`);
  }
  for (const name of liveNames) if (!wanted.has(name)) console.log(`  - /${name} (removed)`);

  if (dryRun) {
    console.log('Dry run: nothing changed.');
    return;
  }
  await rest.put(Routes.applicationCommands(appId), { body });
  console.log(`✅ Registered ${body.length} global commands.`);
}

// Explicit exit: importing the commands opens DB handles that would keep the process alive.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error registering commands:', error);
    process.exit(1);
  });

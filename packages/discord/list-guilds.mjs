#!/usr/bin/env node
import Discord from 'discord.js';
import 'dotenv/config';

const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log('\n🤖 Bot is ready! Logged in as:', client.user.tag);

  console.log('\n📋 GUILDS THE BOT CAN SEE:');
  console.log('='.repeat(60));

  const guilds = client.guilds.cache;
  for (const [guildId, guild] of guilds) {
    console.log(`\n🏰 Guild: ${guild.name}`);
    console.log(`   ID: ${guildId}`);

    // Find forum channels
    const forums = guild.channels.cache.filter(ch => ch.type === Discord.ChannelType.GuildForum);
    if (forums.size > 0) {
      console.log(`\n   📁 FORUMS (${forums.size}):`);
      for (const [channelId, forum] of forums) {
        console.log(`      - ${forum.name} (ID: ${channelId})`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  process.exit(0);
});

console.log('🔐 Logging in to Discord...');
await client.login(process.env.DISCORD_TOKEN);

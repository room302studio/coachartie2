#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';

const CAPS_DIR = 'packages/capabilities/src/capabilities';

const EMOJI_MAP: Record<string, string> = {
  'memory.ts': '🧠',
  'web.ts': '🌐',
  'mcp-client.ts': '🔧',
  'scheduler.ts': '⏰',
  'github.ts': '🐙',
  'variable-store.ts': '💾',
  'email.ts': '📧',
  'wolfram.ts': '📊',
  'mediawiki.ts': '📚',
  'shell.ts': '💻',
  'filesystem.ts': '📁',
  'http.ts': '🌐',
  'goal.ts': '🎯',
  'todo.ts': '✅',
  'discord-channels.ts': '💬',
  'discord-threads.ts': '🧵',
  'discord-forums.ts': '📋',
  'discord-ui.ts': '🎨',
  'discord-send-message.ts': '💬',
  'slack-ui.ts': '💼',
  'linkedin.ts': '💼',
  'package-manager.ts': '📦',
  'system-monitor.ts': '📊',
  'environment.ts': '🌍',
  'mcp-installer.ts': '🔧',
  'mcp-auto-installer.ts': '🤖',
  'embedded-mcp.ts': '🔌',
  'semantic-search.ts': '🔍',
  'user-profile.ts': '👤',
  'model-manager.ts': '🤖',
  'ask-question.ts': '❓',
  'sequence.ts': '🔄',
  'credit-status.ts': '💳',
  'runtime-config.ts': '⚙️',
  'mention-proxy.ts': '🎭',
  'system-installer.ts': '🛠️',
  'discord-issue-parser.ts': '🐛',
  'discord-user-history.ts': '📜',
};

function addEmojiToCapability(filePath: string, emoji: string): boolean {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');

    // Check if emoji already exists
    if (content.includes('emoji:')) {
      console.log(`⏭️  Skipping ${path.basename(filePath)} (emoji already exists)`);
      return false;
    }

    // Find the line with "name: " and add emoji after it
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for the name field in the capability export
      if (line.includes("name: '") || line.includes('name: "')) {
        // Insert emoji on the next line with same indentation
        const indent = line.match(/^(\s*)/)?.[1] || '  ';
        lines.splice(i + 1, 0, `${indent}emoji: '${emoji}',`);
        modified = true;
        break;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, lines.join('\n'));
      console.log(`✅ Added ${emoji} to ${path.basename(filePath)}`);
      return true;
    } else {
      console.log(`⚠️  Could not find name field in ${path.basename(filePath)}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
    return false;
  }
}

// Main execution
let successCount = 0;
let skipCount = 0;
let errorCount = 0;

for (const [fileName, emoji] of Object.entries(EMOJI_MAP)) {
  const filePath = path.join(CAPS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  File not found: ${fileName}`);
    errorCount++;
    continue;
  }

  const result = addEmojiToCapability(filePath, emoji);
  if (result === true) {
    successCount++;
  } else if (result === false && !fs.readFileSync(filePath, 'utf-8').includes('emoji:')) {
    errorCount++;
  } else {
    skipCount++;
  }
}

console.log('\n✨ Summary:');
console.log(`✅ Added: ${successCount}`);
console.log(`⏭️  Skipped: ${skipCount}`);
console.log(`❌ Errors: ${errorCount}`);

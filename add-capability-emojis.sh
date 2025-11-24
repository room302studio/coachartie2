#!/bin/bash
# Script to add emoji field to all capability manifests

CAPS_DIR="packages/capabilities/src/capabilities"

# Function to add emoji after name field
add_emoji() {
  local file="$1"
  local emoji="$2"

  # Check if emoji already exists
  if grep -q "emoji:" "$file"; then
    echo "⏭️  Skipping $file (emoji already exists)"
    return
  fi

  # Add emoji after the name field
  sed -i.bak "/name: /a\\
  emoji: '$emoji'," "$file"

  # Remove backup file
  rm "${file}.bak"

  echo "✅ Added $emoji to $file"
}

# Add emojis to each capability
add_emoji "$CAPS_DIR/memory.ts" "🧠"
add_emoji "$CAPS_DIR/web.ts" "🌐"
add_emoji "$CAPS_DIR/mcp-client.ts" "🔧"
add_emoji "$CAPS_DIR/scheduler.ts" "⏰"
add_emoji "$CAPS_DIR/github.ts" "🐙"
add_emoji "$CAPS_DIR/variable-store.ts" "💾"
add_emoji "$CAPS_DIR/email.ts" "📧"
add_emoji "$CAPS_DIR/wolfram.ts" "📊"
add_emoji "$CAPS_DIR/mediawiki.ts" "📚"
add_emoji "$CAPS_DIR/shell.ts" "💻"
add_emoji "$CAPS_DIR/filesystem.ts" "📁"
add_emoji "$CAPS_DIR/http.ts" "🌐"
add_emoji "$CAPS_DIR/goal.ts" "🎯"
add_emoji "$CAPS_DIR/todo.ts" "✅"
add_emoji "$CAPS_DIR/discord-channels.ts" "💬"
add_emoji "$CAPS_DIR/discord-threads.ts" "🧵"
add_emoji "$CAPS_DIR/discord-forums.ts" "📋"
add_emoji "$CAPS_DIR/discord-ui.ts" "🎨"
add_emoji "$CAPS_DIR/discord-send-message.ts" "💬"
add_emoji "$CAPS_DIR/slack-ui.ts" "💼"
add_emoji "$CAPS_DIR/linkedin.ts" "💼"
add_emoji "$CAPS_DIR/package-manager.ts" "📦"
add_emoji "$CAPS_DIR/system-monitor.ts" "📊"
add_emoji "$CAPS_DIR/environment.ts" "🌍"
add_emoji "$CAPS_DIR/mcp-installer.ts" "🔧"
add_emoji "$CAPS_DIR/mcp-auto-installer.ts" "🤖"
add_emoji "$CAPS_DIR/embedded-mcp.ts" "🔌"
add_emoji "$CAPS_DIR/semantic-search.ts" "🔍"
add_emoji "$CAPS_DIR/user-profile.ts" "👤"
add_emoji "$CAPS_DIR/model-manager.ts" "🤖"
add_emoji "$CAPS_DIR/ask-question.ts" "❓"
add_emoji "$CAPS_DIR/sequence.ts" "🔄"
add_emoji "$CAPS_DIR/credit-status.ts" "💳"
add_emoji "$CAPS_DIR/runtime-config.ts" "⚙️"
add_emoji "$CAPS_DIR/mention-proxy.ts" "🎭"
add_emoji "$CAPS_DIR/system-installer.ts" "🛠️"
add_emoji "$CAPS_DIR/discord-issue-parser.ts" "🐛"
add_emoji "$CAPS_DIR/discord-user-history.ts" "📜"

echo ""
echo "✨ Done! All capability emojis added."

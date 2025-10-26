#!/bin/bash
# Automated Changelog Generator
# Generates changelog from semantic commits and gets LLM summary from Artie
#
# Usage: ./scripts/generate-changelog.sh [version]
# Example: ./scripts/generate-changelog.sh 1.2.0

set -e

VERSION=${1:-"unreleased"}
CHAT_ENDPOINT="http://localhost:47324/chat"

echo "🚀 Generating changelog for version $VERSION..."
echo ""

# Get commits since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$LAST_TAG" ]; then
  echo "📝 No previous tag found, using all commits"
  COMMITS=$(git log --pretty=format:"%h|%s")
else
  echo "📝 Getting commits since $LAST_TAG"
  COMMITS=$(git log ${LAST_TAG}..HEAD --pretty=format:"%h|%s")
fi

if [ -z "$COMMITS" ]; then
  echo "ℹ️  No commits to process"
  exit 0
fi

# Count commits
COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
echo "📊 Found $COMMIT_COUNT commits"
echo ""

# Parse and group commits by type
declare -A GROUPED
while IFS='|' read -r hash message; do
  # Extract type from semantic commit: type(scope): subject
  if [[ $message =~ ^([a-z]+)(\([^)]+\))?(!)?:\ (.+)$ ]]; then
    type="${BASH_REMATCH[1]}"
    scope="${BASH_REMATCH[2]}"
    breaking="${BASH_REMATCH[3]}"
    subject="${BASH_REMATCH[4]}"

    # Format: hash|scope|subject|breaking
    GROUPED[$type]+="$hash|$scope|$subject|$breaking"$'\n'
  else
    echo "⚠️  Non-semantic commit: ${message:0:50}..."
  fi
done <<< "$COMMITS"

# Generate markdown sections
MARKDOWN="## [$VERSION] - $(date +%Y-%m-%d)\n\n"

# Breaking changes first
if [ -n "${GROUPED[feat]}" ] || [ -n "${GROUPED[fix]}" ] || [ -n "${GROUPED[perf]}" ]; then
  # Check for breaking changes
  BREAKING=""
  for type in "${!GROUPED[@]}"; do
    while IFS='|' read -r hash scope subject breaking; do
      if [ "$breaking" = "!" ]; then
        BREAKING+="- **${scope#(}${scope:+: }$subject** (\`${hash:0:7}\`)\n"
      fi
    done <<< "${GROUPED[$type]}"
  done

  if [ -n "$BREAKING" ]; then
    MARKDOWN+="### ⚠️ BREAKING CHANGES\n\n$BREAKING\n"
  fi
fi

# Features
if [ -n "${GROUPED[feat]}" ]; then
  MARKDOWN+="### ✨ Added\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done <<< "${GROUPED[feat]}"
  MARKDOWN+="\n"
fi

# Fixes
if [ -n "${GROUPED[fix]}" ]; then
  MARKDOWN+="### 🐛 Fixed\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done <<< "${GROUPED[fix]}"
  MARKDOWN+="\n"
fi

# Performance
if [ -n "${GROUPED[perf]}" ]; then
  MARKDOWN+="### ⚡ Performance\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done <<< "${GROUPED[perf]}"
  MARKDOWN+="\n"
fi

# Refactoring
if [ -n "${GROUPED[refactor]}" ]; then
  MARKDOWN+="### ♻️ Refactored\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done <<< "${GROUPED[refactor]}"
  MARKDOWN+="\n"
fi

# Documentation
if [ -n "${GROUPED[docs]}" ]; then
  MARKDOWN+="### 📝 Documentation\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done <<< "${GROUPED[docs]}"
  MARKDOWN+="\n"
fi

# Build & CI
if [ -n "${GROUPED[build]}" ] || [ -n "${GROUPED[ci]}" ]; then
  MARKDOWN+="### 🔧 Build & CI\n\n"
  for type in build ci; do
    if [ -n "${GROUPED[$type]}" ]; then
      while IFS='|' read -r hash scope subject breaking; do
        [ -n "$hash" ] && MARKDOWN+="- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
      done <<< "${GROUPED[$type]}"
    fi
  done
  MARKDOWN+="\n"
fi

echo "📄 Generated changelog structure"
echo ""

# Ask Artie to write a summary
echo "🤖 Asking Artie to write a user-friendly summary..."

# Prepare commit list for Artie
COMMIT_LIST=""
while IFS='|' read -r hash message; do
  COMMIT_LIST+="$message\n"
done <<< "$COMMITS"

# Send to Artie
PROMPT="You are a technical writer creating a user-friendly changelog summary.

Given these semantic commits for version $VERSION:

$COMMIT_LIST

Write a brief, engaging 2-3 sentence summary of what changed in this release. Focus on user-facing benefits and improvements. Be conversational but informative.

Example good summary:
\"This release brings powerful new self-monitoring capabilities to Coach Artie! He can now check his own system resources, manage different AI models based on credit availability, and automatically optimize his configuration. Plus, Discord messages now feature rich visual formatting with progress bars and health meters.\"

Your summary:"

MESSAGE_ID=$(curl -s -X POST "$CHAT_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "{\"message\": $(echo "$PROMPT" | jq -Rs .), \"user_id\": \"changelog-generator\"}" \
  | jq -r '.messageId')

if [ -z "$MESSAGE_ID" ] || [ "$MESSAGE_ID" = "null" ]; then
  echo "⚠️  Could not get message ID from Artie (is capabilities service running?)"
  echo ""
  echo -e "$MARKDOWN"
  exit 0
fi

echo "💬 Message ID: $MESSAGE_ID"
echo "⏳ Waiting for Artie's response..."

# Poll for response (max 30 seconds)
for i in {1..10}; do
  sleep 3
  RESPONSE=$(curl -s "$CHAT_ENDPOINT/$MESSAGE_ID")
  STATUS=$(echo "$RESPONSE" | jq -r '.status')

  if [ "$STATUS" = "completed" ]; then
    SUMMARY=$(echo "$RESPONSE" | jq -r '.response')
    echo "✅ Got summary from Artie!"
    echo ""

    # Combine summary with changelog
    FULL_CHANGELOG="## [$VERSION] - $(date +%Y-%m-%d)\n\n**$SUMMARY**\n\n${MARKDOWN#*$'\n'$'\n'}"

    echo "═══════════════════════════════════════════════════════════════"
    echo -e "$FULL_CHANGELOG"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "✨ Copy the above and paste it into CHANGELOG.md"
    echo ""
    exit 0
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ Artie failed to generate summary"
    break
  fi

  echo "   Still processing... ($i/10)"
done

echo "⚠️  Timeout waiting for Artie's response"
echo ""
echo -e "$MARKDOWN"

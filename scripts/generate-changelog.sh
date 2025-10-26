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

# Group commits into separate temp files
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

while IFS='|' read -r hash message; do
  # Extract type from semantic commit: type(scope): subject
  # Match pattern: type(scope)!: subject or type: subject
  type=$(echo "$message" | sed -n 's/^\([a-z]*\).*/\1/p')
  scope=$(echo "$message" | sed -n 's/^[a-z]*(\([^)]*\)).*/\1/p')
  breaking=$(echo "$message" | sed -n 's/^[a-z]*([^)]*)!\?.*\(!\).*/\1/p')
  subject=$(echo "$message" | sed -n 's/^[a-z]*[(:!]*[^:]*: \(.*\)/\1/p')

  if [ -n "$type" ] && [ -n "$subject" ]; then
    # Write to type-specific file
    echo "$hash|$scope|$subject|$breaking" >> "$TMPDIR/$type"
  else
    echo "⚠️  Non-semantic commit: $(echo "$message" | cut -c1-50)..."
  fi
done <<< "$COMMITS"

# Start building markdown
MARKDOWN="## [$VERSION] - $(date +%Y-%m-%d)\n\n"

# Breaking changes first
BREAKING=""
for file in "$TMPDIR"/*; do
  [ -f "$file" ] || continue
  while IFS='|' read -r hash scope subject breaking; do
    if [ "$breaking" = "!" ]; then
      BREAKING="${BREAKING}- **${scope#(}${scope:+: }$subject** (\`${hash:0:7}\`)\n"
    fi
  done < "$file"
done

if [ -n "$BREAKING" ]; then
  MARKDOWN="${MARKDOWN}### ⚠️ BREAKING CHANGES\n\n${BREAKING}\n"
fi

# Features
if [ -f "$TMPDIR/feat" ]; then
  MARKDOWN="${MARKDOWN}### ✨ Added\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/feat"
  MARKDOWN="${MARKDOWN}\n"
fi

# Fixes
if [ -f "$TMPDIR/fix" ]; then
  MARKDOWN="${MARKDOWN}### 🐛 Fixed\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/fix"
  MARKDOWN="${MARKDOWN}\n"
fi

# Performance
if [ -f "$TMPDIR/perf" ]; then
  MARKDOWN="${MARKDOWN}### ⚡ Performance\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/perf"
  MARKDOWN="${MARKDOWN}\n"
fi

# Refactoring
if [ -f "$TMPDIR/refactor" ]; then
  MARKDOWN="${MARKDOWN}### ♻️ Refactored\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/refactor"
  MARKDOWN="${MARKDOWN}\n"
fi

# Documentation
if [ -f "$TMPDIR/docs" ]; then
  MARKDOWN="${MARKDOWN}### 📝 Documentation\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/docs"
  MARKDOWN="${MARKDOWN}\n"
fi

# Build & CI
if [ -f "$TMPDIR/build" ] || [ -f "$TMPDIR/ci" ]; then
  MARKDOWN="${MARKDOWN}### 🔧 Build & CI\n\n"
  for type in build ci; do
    if [ -f "$TMPDIR/$type" ]; then
      while IFS='|' read -r hash scope subject breaking; do
        MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
      done < "$TMPDIR/$type"
    fi
  done
  MARKDOWN="${MARKDOWN}\n"
fi

# Chores
if [ -f "$TMPDIR/chore" ]; then
  MARKDOWN="${MARKDOWN}### 🧹 Chores\n\n"
  while IFS='|' read -r hash scope subject breaking; do
    MARKDOWN="${MARKDOWN}- ${scope#(}${scope:+: }$subject (\`${hash:0:7}\`)\n"
  done < "$TMPDIR/chore"
  MARKDOWN="${MARKDOWN}\n"
fi

echo "📄 Generated changelog structure"
echo ""

# Ask Artie to write a summary
echo "🤖 Asking Artie to write a user-friendly summary..."

# Prepare commit list for Artie
COMMIT_LIST=$(echo "$COMMITS" | cut -d'|' -f2)

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

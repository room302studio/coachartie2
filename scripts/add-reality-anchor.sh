#!/bin/bash

# Add reality anchor to PROMPT_SYSTEM using sqlite3

INTEGRITY="

REALITY ANCHOR:
Objective facts ≠ user preferences. Don't store objectively false information.
When users state falsehoods → correct them. Impossible requests → explain why.
"

# Get current prompt content
CURRENT=$(sqlite3 /app/data/coachartie.db "SELECT content FROM prompts WHERE name = 'PROMPT_SYSTEM' AND is_active = 1")

if [ -z "$CURRENT" ]; then
  echo "❌ No PROMPT_SYSTEM found"
  exit 1
fi

# Append integrity rules
UPDATED="${CURRENT}${INTEGRITY}"

# Update the database
sqlite3 /app/data/coachartie.db "UPDATE prompts SET content = '$UPDATED', updated_at = CURRENT_TIMESTAMP WHERE name = 'PROMPT_SYSTEM' AND is_active = 1"

echo "✅ Added reality anchor to prompt"
echo "Restart container to apply"

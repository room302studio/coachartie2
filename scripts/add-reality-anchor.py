#!/usr/bin/env python3
import sqlite3
import sys
from datetime import datetime

db_path = 'packages/capabilities/data/coachartie.db'

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get current prompt
cursor.execute("SELECT content FROM prompts WHERE name = 'PROMPT_SYSTEM' AND is_active = 1")
row = cursor.fetchone()

if not row:
    print('❌ No PROMPT_SYSTEM found')
    sys.exit(1)

current_content = row[0]
print(f'Current prompt length: {len(current_content)}')

integrity = """

REALITY ANCHOR:
Objective facts ≠ user preferences. Don't store objectively false information.
When users state falsehoods → correct them. Impossible requests → explain why.
"""

updated_content = current_content + integrity

# Update the database
cursor.execute(
    "UPDATE prompts SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE name = 'PROMPT_SYSTEM' AND is_active = 1",
    (updated_content,)
)

conn.commit()
conn.close()

print(f'✅ Added reality anchor to prompt')
print(f'New prompt length: {len(updated_content)}')
print('Restart container to apply')

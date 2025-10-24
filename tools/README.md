# Prompt Database Tools

Meta-tooling for viewing, accessing, and editing the prompt database.

## Tools

### 1. Prompt TUI (`prompt-tui.ts`)

Interactive terminal UI for browsing and editing prompts. Perfect for humans!

**Features:**
- 📋 Browse all prompts with filtering
- 🔍 View prompt details and history
- ✏️ Edit prompts in-place
- 🔄 Real-time updates
- 🎨 Beautiful terminal UI
- ⚡ Keyboard shortcuts (vim-style!)

**Usage:**
```bash
npm run prompt:tui
# or
./tools/prompt-tui.ts
```

**Keyboard Shortcuts:**
| Key | Action |
|-----|--------|
| `↑/k` | Move up |
| `↓/j` | Move down |
| `Tab` | Switch panel |
| `Enter` | View details |
| `e` | Edit selected prompt |
| `h` | View history |
| `t` | Toggle active status |
| `r` | Refresh list |
| `c` | Clear cache |
| `?` | Show help |
| `q` | Quit |

### 2. Prompt CLI (`prompt-cli.ts`)

Command-line interface for programmatic access. Perfect for AI and scripting!

**Features:**
- 🤖 AI-friendly programmatic interface
- 📝 Export/import prompts as JSON
- 🔄 Version control integration
- 🎯 Scriptable operations
- 📊 Machine-readable output

**Usage:**
```bash
npm run prompt:cli -- <command> [args]
# or
./tools/prompt-cli.ts <command> [args]
```

**Commands:**
```bash
# List all prompts
prompt-cli list

# List prompts by category
prompt-cli list system

# View prompt details
prompt-cli view PROMPT_SYSTEM

# Edit prompt in $EDITOR
prompt-cli edit PROMPT_SYSTEM

# Create new prompt
prompt-cli create my-prompt system

# View version history
prompt-cli history PROMPT_SYSTEM

# Toggle active status
prompt-cli toggle PROMPT_SYSTEM

# Export single prompt
prompt-cli export PROMPT_SYSTEM

# Export all prompts
prompt-cli export

# Import prompts
prompt-cli import prompts.json
```

## AI Usage

Both tools are designed to be AI-friendly:

### For Claude Code (me):

```typescript
// List prompts programmatically
await Bash({ command: './tools/prompt-cli.ts list' });

// View specific prompt
await Bash({ command: './tools/prompt-cli.ts view PROMPT_SYSTEM' });

// Export for analysis
await Bash({ command: './tools/prompt-cli.ts export' });

// Edit programmatically (uses $EDITOR)
await Bash({ command: 'EDITOR=vim ./tools/prompt-cli.ts edit PROMPT_SYSTEM' });
```

### For Humans:

Just run the TUI for the best experience:
```bash
npm run prompt:tui
```

## Database Structure

Prompts are stored in SQLite with the following schema:

```sql
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  metadata TEXT,
  changed_by TEXT,
  change_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id)
);
```

## Examples

### Export and Edit Workflow

```bash
# 1. Export current prompt
./tools/prompt-cli.ts export PROMPT_SYSTEM

# 2. Edit the JSON
vim prompt-PROMPT_SYSTEM-*.json

# 3. Import back
./tools/prompt-cli.ts import prompt-PROMPT_SYSTEM-*.json
```

### Batch Operations

```bash
# Export all prompts for backup
./tools/prompt-cli.ts export > prompts-backup.json

# Create multiple prompts from template
for name in prompt1 prompt2 prompt3; do
  ./tools/prompt-cli.ts create $name system
done
```

### AI-Assisted Editing

```bash
# Export prompt to file
./tools/prompt-cli.ts view PROMPT_SYSTEM > current-prompt.txt

# Edit with AI assistance (via Claude Code, ChatGPT, etc.)
# ...

# Update prompt
cat current-prompt.txt | ./tools/prompt-cli.ts edit PROMPT_SYSTEM
```

## Tips

1. **Hot Reloading**: Prompts are cached for 30 seconds. Use `r` in TUI or re-run CLI to refresh.

2. **Version Control**: All edits are versioned. Use `history` command to see changes.

3. **Categories**: Organize prompts by category (`system`, `capability`, `user`, etc.)

4. **Active Status**: Inactive prompts are ignored by the system. Toggle with `t` or `toggle`.

5. **Export Format**: JSON exports include all metadata, perfect for version control.

6. **Editor Choice**: Set `$EDITOR` environment variable for your preferred editor.

## Troubleshooting

**TUI not rendering correctly?**
- Make sure your terminal supports 256 colors
- Try a different terminal (iTerm2, Alacritty, etc.)

**CLI can't find database?**
- Make sure you're running from the repo root
- Check that SQLite database exists at `data/coachartie.db`

**Permission denied?**
- Run `chmod +x tools/prompt-*.ts`

**Import fails?**
- Validate JSON format
- Check that prompt names don't conflict

## Development

The tools use:
- `blessed` - Terminal UI library
- `prompt-manager` - Database abstraction
- `tsx` - TypeScript execution

To modify the tools, edit the respective TypeScript files and they'll run directly with `tsx`.

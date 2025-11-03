# Shell Capability - Artie's Laptop

## What Is This?

Artie now has access to a **persistent sandboxed Debian environment** - basically his own laptop. Instead of building wrappers for every CLI tool (gh, jq, curl, etc.), he can now execute commands directly.

## Architecture

```
┌─────────────────────────────────────┐
│ Coach Artie                         │
│  └─> Wants to check GitHub issues   │
└──────────────┬──────────────────────┘
               │
               v
┌─────────────────────────────────────┐
│ Shell Capability                    │
│  <capability name="shell"           │
│    command="gh issue list -R ..." />│
└──────────────┬──────────────────────┘
               │
               v docker exec
┌─────────────────────────────────────┐
│ Sandbox Container (artie-laptop)    │
│  - Debian bookworm-slim             │
│  - Persistent /workspace volume     │
│  - Pre-installed: gh, git, jq, curl │
│  - Can install: any apt package     │
│  - Isolated: can't touch host OS    │
└─────────────────────────────────────┘
```

## Pre-installed Tools

- **git** - Version control
- **gh** - GitHub CLI
- **jq** - JSON processing
- **curl/wget** - HTTP requests
- **npm/node** - JavaScript runtime
- **python3/pip** - Python runtime
- **sqlite3** - Database
- **claude-code** - Meta! Artie can use Claude Code
- **vim/nano** - Text editors

## Usage Examples

### Check GitHub Issues
```xml
<capability name="shell" command="gh issue list -R owner/repo --limit 10" />
```

### Parse JSON with jq
```xml
<capability name="shell" command="curl -s https://api.github.com/repos/owner/repo | jq '.stargazers_count'" />
```

### Clone and Analyze a Repo
```xml
<capability name="shell" cwd="/workspace" command="
git clone https://github.com/owner/repo &&
cd repo &&
find . -name '*.js' | wc -l
" />
```

### Install and Use New Tools
```xml
<capability name="shell" command="apt-get update && apt-get install -y ripgrep && rg 'TODO' /workspace" />
```

### Use Claude Code (Meta!)
```xml
<capability name="shell" command="claude-code --help" />
```

## Parameters

- **command** (required): Shell command to execute
- **cwd** (optional): Working directory (default: `/workspace`)
- **timeout** (optional): Max execution time in ms (default: 30000 / 30s)

## Security

- ✅ Fully isolated from host OS
- ✅ No privileged mode
- ✅ Resource limits (512MB RAM, 1 CPU)
- ✅ Even `rm -rf /` won't affect host
- ✅ Timeout enforcement prevents runaway processes

## Persistent Storage

- `/workspace` - Persistent volume for repos, files, etc.
- `/root` - Persistent home directory (config files, .gitconfig, etc.)

These volumes survive container restarts. If Artie breaks something, we can nuke it and rebuild:

```bash
docker-compose down sandbox
docker volume rm coachartie2_sandbox-workspace coachartie2_sandbox-home
docker-compose up -d sandbox
```

## Philosophy: Primitives over Wrappers

**Old Way (Wrong):**
```typescript
// Build wrapper for every tool
githubActions.list_issues()
githubActions.create_webhook()
githubActions.delete_webhook()
// ... endless wrappers
```

**New Way (Right):**
```xml
<!-- Give Artie the raw tool -->
<capability name="shell" command="gh issue list -R owner/repo" />
<capability name="shell" command="gh webhook create ..." />
<capability name="shell" command="gh webhook delete ..." />
```

Artie learns CLI tools naturally. He can read docs, experiment, and compose solutions. We give him **primitives** (shell access, memory, capabilities), not **constraints** (hardcoded API wrappers).

## Example: Setting Up GitHub Webhook

Instead of building a `github.ts` wrapper with `create_webhook` action, Artie can:

1. Remember the user's request in his variable store
2. Use shell to check if webhook exists: `gh api repos/owner/repo/hooks`
3. Create webhook if needed: `gh api repos/owner/repo/hooks -F url=... -F events[]=release`
4. Store the webhook ID in his memory
5. Later, update or delete it as needed

All without us writing a single line of wrapper code.

## Testing

```bash
# Start sandbox
docker-compose up -d sandbox

# Wait for it to install tools (~60s first time)
docker-compose logs -f sandbox

# Test manual access
docker exec -it coachartie-sandbox bash

# Inside sandbox:
gh --version
git --version
claude-code --version
```

## What This Enables

- **Self-service GitHub management** - Artie can set up webhooks, manage issues, etc.
- **Dynamic tool installation** - Need ffmpeg? `apt-get install ffmpeg`
- **Repository analysis** - Clone, search, analyze codebases
- **API exploration** - Use curl + jq to explore any API
- **Meta-programming** - Artie can use Claude Code to write code!

## Future Ideas

- **Multi-command scripts** - Chain commands in Artie's memory
- **Tool installation learning** - Artie learns what tools exist via `apt-cache search`
- **Workspace snapshots** - Save/restore workspace states
- **Resource monitoring** - Artie learns his resource limits

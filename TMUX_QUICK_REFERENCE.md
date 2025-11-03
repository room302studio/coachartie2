# Tmux Quick Reference for Coach Artie

## TL;DR

Tmux gives you persistent terminal sessions with multiple panes. Think of it as having multiple terminal windows that survive disconnection.

## Core Concepts

```
Session (artie)
  └── Windows (workspace, projects, etc)
      └── Panes (0.0, 0.1, 0.2)
```

- **Session**: Main container, persists forever
- **Window**: Like a tab, contains multiple panes
- **Pane**: Individual terminal, has its own command running

## Essential Actions

### 1. Start Using Tmux

```xml
<capability name="tmux" action="init" />
```

Do this once before anything else. Creates the `artie` session.

### 2. Run a Command

```xml
<capability name="tmux" action="send"
  pane="0.0"
  command="npm test" />
```

Sends command to pane. Command runs in background.

### 3. Check Output

```xml
<capability name="tmux" action="read"
  pane="0.0"
  lines="50" />
```

Shows what the command printed. You can read same pane multiple times.

### 4. See What's Running

```xml
<capability name="tmux" action="list" />
```

Shows all windows and panes with their current commands.

### 5. Create New Pane

```xml
<capability name="tmux" action="split"
  window="0"
  direction="vertical" />
```

Splits current pane into two. Now you have 0.0 and 0.1.

### 6. Clean Up

```xml
<capability name="tmux" action="kill" pane="0.1" />
```

Destroys pane when you're done with it.

## Typical Workflows

### Run and Monitor

```xml
<!-- Start it -->
<capability name="tmux" action="send"
  command="npm run dev" />

<!-- Do other stuff... -->

<!-- Check on it later -->
<capability name="tmux" action="read" pane="0.0" />
```

### Run Multiple Things

```xml
<!-- Create extra panes -->
<capability name="tmux" action="split" direction="horizontal" />
<capability name="tmux" action="split" direction="vertical" />

<!-- Now you have 0.0, 0.1, 0.2 -->

<!-- Start different things in each -->
<capability name="tmux" action="send" pane="0.0" command="npm run server" />
<capability name="tmux" action="send" pane="0.1" command="npm run worker" />
<capability name="tmux" action="send" pane="0.2" command="tail -f logs.txt" />

<!-- Read any pane to check it -->
<capability name="tmux" action="read" pane="0.1" />
```

### Organize by Project

```xml
<!-- Create window for new project -->
<capability name="tmux" action="window" name="project-x" />

<!-- Now you have window 1, work there -->
<capability name="tmux" action="send" pane="1.0"
  command="git clone https://github.com/user/project-x && cd project-x" />

<!-- Split it up -->
<capability name="tmux" action="split" window="1" direction="vertical" />

<!-- Use one pane for editing, one for running -->
<capability name="tmux" action="send" pane="1.1"
  command="npm install && npm start" />
```

## Pane Addressing

- **0.0** = Window 0, Pane 0 (main workspace)
- **0.1** = Window 0, Pane 1 (second pane)
- **1.0** = Window 1, Pane 0 (different window)

Default is always `0.0` if you don't specify.

## Common Mistakes

### ❌ Wrong: Expecting output immediately

```xml
<capability name="tmux" action="send" command="npm test" />
<capability name="tmux" action="read" pane="0.0" />
<!-- Too fast! Command hasn't produced output yet -->
```

### ✅ Right: Wait or do other work first

```xml
<capability name="tmux" action="send" command="npm test" />
<!-- Do other stuff, or explicit wait -->
<capability name="tmux" action="read" pane="0.0" />
```

### ❌ Wrong: Using tmux for quick commands

```xml
<capability name="tmux" action="send" command="ls -la" />
```

### ✅ Right: Use shell capability for quick commands

```xml
<capability name="shell" command="ls -la" />
```

**Rule of thumb:** Use tmux when command takes >5 seconds or you need to check on it later.

## Parameters Cheatsheet

### send
- `pane` - Which pane (default: 0.0)
- `command` - What to run (required)
- `clear` - Clear pane first (default: false)

### read
- `pane` - Which pane (default: 0.0)
- `lines` - How many lines (default: 100)
- `all` - Get entire scrollback (default: false)
- `since` - Only new output (default: false)

### split
- `window` - Which window (default: 0)
- `direction` - "horizontal" or "vertical" (required)
- `title` - Name for pane (optional)
- `cwd` - Working directory (optional)

### kill
- `pane` - Which pane to kill (e.g., "0.1")
- `window` - Or kill whole window (e.g., "1")

### window
- `name` - Window name (optional)
- `cwd` - Working directory (optional)

## Decision Tree

```
Need to run a command?
│
├─ Takes < 5 seconds?
│  └─ Use: <capability name="shell" />
│
├─ Long-running (server, watcher)?
│  └─ Use: <capability name="tmux" action="send" />
│
├─ Multiple things at once?
│  ├─ Same window? → split then send
│  └─ Different projects? → window then send
│
└─ Check on something you started?
   └─ Use: <capability name="tmux" action="read" />
```

## Debugging

### See all panes and what they're doing

```xml
<capability name="tmux" action="list" />
```

Response shows:
- All windows
- All panes in each window
- What command is running in each pane
- Working directory

### Check if command is still running

Read the pane. If output stopped, command likely finished.

```xml
<capability name="tmux" action="read" pane="0.0" />
```

Look for:
- Exit codes
- Error messages
- Prompts (means command finished)

### Kill stuck command

```xml
<capability name="tmux" action="send"
  pane="0.0"
  command="^C" />
```

Note: `^C` sends Ctrl+C to interrupt.

Or just kill the whole pane:

```xml
<capability name="tmux" action="kill" pane="0.0" />
```

## Real-World Examples

### Example 1: Build and Check

```xml
<!-- Start build -->
<capability name="tmux" action="init" />
<capability name="tmux" action="send"
  command="npm run build" />

<!-- Check progress after 10 seconds -->
<capability name="tmux" action="read" lines="100" />

<!-- If successful, verify output -->
<capability name="shell" command="ls -lh dist/" />

<!-- Clean up -->
<capability name="tmux" action="kill" pane="0.0" />
```

### Example 2: Dev Server + Logs

```xml
<!-- Setup: one pane for server, one for logs -->
<capability name="tmux" action="init" />
<capability name="tmux" action="split" direction="vertical" />

<!-- Start server in 0.0 -->
<capability name="tmux" action="send"
  pane="0.0"
  command="npm run dev" />

<!-- Watch logs in 0.1 -->
<capability name="tmux" action="send"
  pane="0.1"
  command="tail -f /workspace/logs/app.log" />

<!-- Later: check both -->
<capability name="tmux" action="read" pane="0.0" lines="20" />
<capability name="tmux" action="read" pane="0.1" lines="20" />
```

### Example 3: Test Multiple Projects

```xml
<!-- Create windows for each project -->
<capability name="tmux" action="init" />
<capability name="tmux" action="window" name="project-a" />
<capability name="tmux" action="window" name="project-b" />

<!-- Run tests in parallel -->
<capability name="tmux" action="send"
  pane="0.0"
  command="cd /workspace/project-a && npm test" />

<capability name="tmux" action="send"
  pane="1.0"
  command="cd /workspace/project-b && npm test" />

<capability name="tmux" action="send"
  pane="2.0"
  command="cd /workspace/project-c && npm test" />

<!-- Check all results -->
<capability name="tmux" action="read" pane="0.0" />
<capability name="tmux" action="read" pane="1.0" />
<capability name="tmux" action="read" pane="2.0" />
```

### Example 4: Interactive Debugging

```xml
<!-- Start node REPL -->
<capability name="tmux" action="send"
  command="node" />

<!-- Send code to evaluate -->
<capability name="tmux" action="send"
  pane="0.0"
  command="const x = require('./mymodule')" />

<capability name="tmux" action="send"
  pane="0.0"
  command="x.testFunction()" />

<!-- Read output -->
<capability name="tmux" action="read" pane="0.0" />

<!-- Exit REPL when done -->
<capability name="tmux" action="send"
  pane="0.0"
  command=".exit" />
```

## Tips

1. **Always init first** - Session persists, so you only need to init once per sandbox restart

2. **List before acting** - When in doubt, list panes to see current state

3. **Read to verify** - After sending a command, read to make sure it worked

4. **Clean up** - Kill panes you're not using anymore to keep things tidy

5. **Use windows for projects** - Keep different projects in different windows

6. **Name things** - Use titles and window names to remember what's what

7. **Check running state** - Read pane to see if command finished or still running

8. **One session is enough** - The `artie` session with multiple windows/panes is all you need

## Advanced: Reading Incremental Output

For long-running commands, you can track position and read only new output:

```xml
<!-- First read -->
<capability name="tmux" action="read" pane="0.0" />
<!-- Returns: cursor_position: 100 -->

<!-- Wait for more output -->

<!-- Read only new stuff -->
<capability name="tmux" action="read"
  pane="0.0"
  since="true" />
<!-- Returns only lines after 100 -->
```

This avoids re-processing output you've already seen.

## FAQ

**Q: What happens if container restarts?**
A: Session is lost. Run init again and recreate your panes.

**Q: Can I send Ctrl+C?**
A: Yes! `<capability name="tmux" action="send" command="^C" />`

**Q: How do I know if command finished?**
A: Read the pane. Look for shell prompt or exit messages.

**Q: Can I run interactive programs?**
A: Yes! Vim, less, htop, node REPL all work. Send commands/keys as needed.

**Q: What if I forget what panes I have?**
A: `<capability name="tmux" action="list" />`

**Q: Can I see command history?**
A: Read pane with `all=true` to get entire scrollback (up to 10,000 lines).

**Q: How do I kill everything?**
A: Kill each window or just let container restart. Session will be destroyed.

## When NOT to Use Tmux

- Quick commands that finish immediately (use `shell` capability)
- Single command with no monitoring needed
- When you just need output, not persistence
- Simple file operations

**Remember:** Tmux is for **persistent**, **concurrent**, **long-running** workflows. For quick tasks, use the shell capability.

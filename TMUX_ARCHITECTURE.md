# Tmux Architecture for Coach Artie Sandbox

## Overview

This document defines the tmux architecture for Coach Artie's sandbox environment, enabling persistent shell sessions with multiple panes instead of one-shot command execution.

**Current State:** One-shot commands via `docker exec`
**New State:** Persistent tmux sessions with multiple panes for concurrent workflows

## Design Principles

1. **Simple for LLM** - Clear, predictable API with minimal cognitive overhead
2. **Stateful** - Sessions and panes persist between commands
3. **Observable** - Easy to inspect what's running and capture output
4. **Forgiving** - Graceful handling of errors and edge cases

## Session Structure

### Single Main Session

**Decision:** Use ONE main session called `artie` that's always available.

**Rationale:**
- Simpler mental model for the LLM
- No need to track multiple session names
- Can still have multiple windows/panes within the session
- Sessions persist until explicitly destroyed

### Window Organization

```
Session: artie
├── Window 0: "workspace" (default)
│   ├── Pane 0.0 - Primary workspace
│   ├── Pane 0.1 - Secondary task
│   └── Pane 0.2 - Monitoring
├── Window 1: "projects"
│   ├── Pane 1.0 - Project A
│   └── Pane 1.1 - Project B
└── Window 2: "experiments"
    └── Pane 2.0 - Scratch space
```

**Window Types:**
- **0 (workspace)**: Default working environment, general tasks
- **1 (projects)**: Long-running project work
- **2+ (custom)**: User-defined or specialized tasks

## Pane Identification

### Addressing Scheme

Panes are identified by **window.pane** notation:

- `0.0` = Window 0, Pane 0 (main workspace)
- `1.2` = Window 1, Pane 2
- Default target if unspecified: `0.0`

**Why this approach:**
- Simple and predictable
- Window.Pane maps to tmux's native targeting
- Easy for LLM to remember and use
- Survives pane reordering within limits

### Pane Metadata

Each pane maintains metadata via tmux environment variables:
- `PANE_TITLE` - Human-readable description
- `PANE_CWD` - Working directory
- `PANE_CREATED` - Timestamp

## Capability API

### Action: init

Initialize the tmux session (idempotent).

```xml
<capability name="tmux" action="init" />
```

**Behavior:**
- Creates session `artie` if it doesn't exist
- Creates default window 0 with pane 0.0
- Sets up working directory `/workspace`
- Returns session info

**Response:**
```json
{
  "success": true,
  "data": {
    "session": "artie",
    "windows": [
      {"id": 0, "name": "workspace", "panes": 1}
    ],
    "active_pane": "0.0"
  }
}
```

### Action: send

Send a command to a specific pane.

```xml
<capability name="tmux" action="send"
  pane="0.0"
  command="npm test" />
```

**Parameters:**
- `pane` (optional) - Target pane, defaults to `0.0`
- `command` (required) - Command to execute
- `clear` (optional) - Clear pane before sending (default: false)

**Behavior:**
- Sends command + Enter key to pane
- Does NOT wait for completion
- Command runs in pane's current working directory

**Response:**
```json
{
  "success": true,
  "data": {
    "pane": "0.0",
    "command": "npm test",
    "sent_at": "2025-01-24T10:30:00Z"
  }
}
```

### Action: read

Capture output from a pane.

```xml
<capability name="tmux" action="read"
  pane="0.0"
  lines="50" />
```

**Parameters:**
- `pane` (optional) - Target pane, defaults to `0.0`
- `lines` (optional) - Number of lines to capture (default: 100)
- `all` (optional) - Capture entire scrollback (default: false)
- `since` (optional) - Only new output since last read (default: false)

**Behavior:**
- Captures visible + scrollback content
- Returns trimmed output
- Can track position for incremental reads

**Response:**
```json
{
  "success": true,
  "data": {
    "pane": "0.0",
    "output": "test output here...",
    "lines_captured": 50,
    "cursor_position": "150",
    "has_more": true
  }
}
```

### Action: split

Create a new pane by splitting an existing one.

```xml
<capability name="tmux" action="split"
  window="0"
  direction="vertical" />
```

**Parameters:**
- `window` (optional) - Target window, defaults to 0
- `direction` (required) - `horizontal` or `vertical`
- `title` (optional) - Human-readable pane title
- `cwd` (optional) - Working directory for new pane

**Behavior:**
- Splits the currently active pane in the window
- New pane gets next index number
- Inherits working directory unless `cwd` specified

**Response:**
```json
{
  "success": true,
  "data": {
    "pane": "0.1",
    "window": 0,
    "title": "New pane",
    "cwd": "/workspace"
  }
}
```

### Action: list

List all windows and panes.

```xml
<capability name="tmux" action="list" />
```

**Response:**
```json
{
  "success": true,
  "data": {
    "session": "artie",
    "windows": [
      {
        "id": 0,
        "name": "workspace",
        "panes": [
          {
            "id": "0.0",
            "title": "main",
            "cwd": "/workspace",
            "active": true,
            "running": "npm test"
          },
          {
            "id": "0.1",
            "title": "monitoring",
            "cwd": "/workspace",
            "active": false,
            "running": "tail -f logs.txt"
          }
        ]
      }
    ]
  }
}
```

### Action: kill

Destroy a pane or window.

```xml
<capability name="tmux" action="kill" pane="0.1" />
<capability name="tmux" action="kill" window="2" />
```

**Parameters:**
- `pane` (optional) - Target pane to kill
- `window` (optional) - Target window to kill (kills all panes)

**Behavior:**
- Terminates any running processes
- Removes pane/window from session
- Cannot kill the last pane (would destroy session)

**Response:**
```json
{
  "success": true,
  "data": {
    "killed": "0.1",
    "type": "pane"
  }
}
```

### Action: window

Create a new window.

```xml
<capability name="tmux" action="window"
  name="experiments" />
```

**Parameters:**
- `name` (optional) - Window name
- `cwd` (optional) - Working directory

**Response:**
```json
{
  "success": true,
  "data": {
    "window": 2,
    "name": "experiments",
    "pane": "2.0"
  }
}
```

## Output Capture Strategy

### Incremental Reading

Track read position per pane to avoid re-reading old output:

```typescript
interface ReadState {
  pane: string;
  last_line_read: number;
  timestamp: string;
}
```

**Implementation:**
1. First read: Capture all visible content
2. Store cursor position (line number)
3. Subsequent reads: Use `-S <last_line>` to get only new content
4. Reset on explicit `all=true` flag

### Scrollback Limits

- Default capture: 100 lines
- Max scrollback: 10,000 lines (configurable)
- Set in tmux: `set-option -g history-limit 10000`

### Pane State Detection

Detect if pane has running command:

```bash
# Get pane PID
tmux display -p -t 0.0 '#{pane_pid}'

# Check if process is running
ps -o stat= -p <pid> | grep -q 'R\|S'
```

## Command Patterns

### Setup Tmux in Container

Add to sandbox container startup:

```dockerfile
# Install tmux
RUN apt-get update && apt-get install -y tmux

# Configure tmux
RUN echo "set -g history-limit 10000" > /root/.tmux.conf && \
    echo "set -g mouse on" >> /root/.tmux.conf && \
    echo "set -g status-style bg=blue,fg=white" >> /root/.tmux.conf
```

### Execute via Docker

All tmux commands go through docker exec:

```bash
docker exec coachartie-sandbox tmux <command>
```

### Common Patterns

**Initialize session:**
```bash
docker exec coachartie-sandbox bash -c "
  tmux has-session -t artie 2>/dev/null || \
  tmux new-session -d -s artie -n workspace -c /workspace
"
```

**Send command:**
```bash
docker exec coachartie-sandbox tmux send-keys -t artie:0.0 'ls -la' Enter
```

**Capture output:**
```bash
docker exec coachartie-sandbox tmux capture-pane -t artie:0.0 -p -S -100
```

**Split pane:**
```bash
docker exec coachartie-sandbox tmux split-window -t artie:0 -v -c /workspace
```

**List panes:**
```bash
docker exec coachartie-sandbox tmux list-panes -s -t artie \
  -F '#{window_index}.#{pane_index}|#{pane_current_path}|#{pane_current_command}'
```

**Kill pane:**
```bash
docker exec coachartie-sandbox tmux kill-pane -t artie:0.1
```

## Error Handling

### Session Doesn't Exist

**Error:** `tmux: can't find session: artie`

**Recovery:** Auto-initialize session on any action
```typescript
try {
  await execTmuxCommand(cmd);
} catch (err) {
  if (err.includes("can't find session")) {
    await initSession();
    await execTmuxCommand(cmd); // Retry
  }
}
```

### Pane Doesn't Exist

**Error:** `tmux: can't find pane: 0.5`

**Recovery:** Return clear error, suggest listing panes
```json
{
  "success": false,
  "error": "Pane 0.5 not found",
  "suggestion": "Use action='list' to see available panes"
}
```

### Container Not Running

**Error:** `docker exec: container not running`

**Recovery:** Cannot auto-recover, return error
```json
{
  "success": false,
  "error": "Sandbox container not running",
  "suggestion": "Start container: docker-compose up -d sandbox"
}
```

### Command Timeout

For long-running commands, don't wait:
- `send` action returns immediately
- Use `read` action to check output later
- Track command state in pane metadata

## Usage Examples

### Example 1: Run Tests in Background

```xml
<!-- Initialize tmux -->
<capability name="tmux" action="init" />

<!-- Start test suite -->
<capability name="tmux" action="send"
  pane="0.0"
  command="npm test -- --watch" />

<!-- Check output after 5 seconds -->
<capability name="tmux" action="read"
  pane="0.0"
  lines="50" />
```

### Example 2: Monitor Multiple Processes

```xml
<!-- Create monitoring panes -->
<capability name="tmux" action="split"
  window="0"
  direction="horizontal" />

<!-- Start first process in 0.0 -->
<capability name="tmux" action="send"
  pane="0.0"
  command="npm run dev" />

<!-- Start second process in 0.1 -->
<capability name="tmux" action="send"
  pane="0.1"
  command="tail -f /var/log/app.log" />

<!-- Read both -->
<capability name="tmux" action="read" pane="0.0" />
<capability name="tmux" action="read" pane="0.1" />
```

### Example 3: Project Workspace

```xml
<!-- Create project window -->
<capability name="tmux" action="window"
  name="myproject" />

<!-- Clone repo in new window -->
<capability name="tmux" action="send"
  pane="1.0"
  command="git clone https://github.com/user/repo && cd repo" />

<!-- Split for editor and terminal -->
<capability name="tmux" action="split"
  window="1"
  direction="vertical" />

<!-- Run dev server in bottom pane -->
<capability name="tmux" action="send"
  pane="1.1"
  command="npm install && npm run dev" />
```

### Example 4: Incremental Output Reading

```xml
<!-- Start long-running command -->
<capability name="tmux" action="send"
  pane="0.0"
  command="npm run build" />

<!-- First read -->
<capability name="tmux" action="read"
  pane="0.0"
  lines="100" />
<!-- Returns cursor_position: 100 -->

<!-- Later, read only new output -->
<capability name="tmux" action="read"
  pane="0.0"
  since="true" />
<!-- Returns only lines after 100 -->
```

## Advanced Features (Future)

### Pane Recording

Continuously pipe output to file:
```bash
tmux pipe-pane -t 0.0 'cat >> /workspace/logs/pane-0.0.log'
```

### Synchronized Panes

Execute same command in multiple panes:
```bash
tmux setw synchronize-panes on
```

### Pane Layouts

Save/restore pane arrangements:
```bash
tmux list-windows -F '#{window_layout}'
tmux select-layout <layout-string>
```

### Session Snapshots

Save entire session state:
```bash
tmux run-shell "tmux showenv -s > /workspace/.tmux-session"
```

## LLM Usage Guidelines

### When to Use Tmux

**Good Use Cases:**
- Long-running processes (dev servers, builds, tests)
- Monitoring multiple streams (logs, metrics)
- Concurrent tasks (compile + run + monitor)
- Interactive sessions (REPL, shell navigation)

**Bad Use Cases:**
- Quick one-off commands (use shell capability)
- Commands that complete in <5 seconds
- Non-interactive scripts

### Best Practices for Artie

1. **Initialize first:** Always run `init` action before using tmux
2. **List before acting:** Use `list` to see current state
3. **Read after send:** Wait a moment, then read output
4. **Clean up:** Kill panes when done to avoid clutter
5. **Use meaningful titles:** Set pane titles for tracking

### Common Patterns

**Pattern: Run and Monitor**
```
1. init
2. send command
3. wait/do other work
4. read output
5. kill pane when done
```

**Pattern: Parallel Tasks**
```
1. init
2. split multiple times
3. send different commands to each pane
4. read all panes to check status
```

**Pattern: Project Setup**
```
1. window (create new)
2. send (clone repo)
3. split (create dev/monitor panes)
4. send to each pane (install, start, logs)
```

## Implementation Checklist

- [ ] Install tmux in sandbox container
- [ ] Configure tmux defaults (.tmux.conf)
- [ ] Create tmux capability handler
- [ ] Implement all actions (init, send, read, split, list, kill, window)
- [ ] Add error handling and recovery
- [ ] Track read state for incremental output
- [ ] Add pane metadata tracking
- [ ] Test all usage examples
- [ ] Add to capability registry
- [ ] Document in capability list

## Testing Strategy

### Manual Tests

1. **Basic workflow:**
   ```bash
   # Init session
   docker exec coachartie-sandbox tmux new -d -s artie -n workspace

   # Send command
   docker exec coachartie-sandbox tmux send-keys -t artie:0.0 'echo hello' Enter

   # Read output
   docker exec coachartie-sandbox tmux capture-pane -t artie:0.0 -p
   ```

2. **Pane management:**
   ```bash
   # Split
   docker exec coachartie-sandbox tmux split-window -t artie:0 -v

   # List
   docker exec coachartie-sandbox tmux list-panes -s -t artie

   # Kill
   docker exec coachartie-sandbox tmux kill-pane -t artie:0.1
   ```

3. **Error cases:**
   - Try to read non-existent pane
   - Try to send command before init
   - Kill last pane (should fail gracefully)

### Integration Tests

Test through the capability API:
```xml
<capability name="tmux" action="init" />
<capability name="tmux" action="send" command="echo test" />
<capability name="tmux" action="read" />
```

Verify response structure matches spec.

## Migration Path

### Phase 1: Implement Core Actions
- `init`, `send`, `read`
- Get basic workflow working

### Phase 2: Add Pane Management
- `split`, `list`, `kill`
- Test multi-pane scenarios

### Phase 3: Polish
- Window management (`window` action)
- Incremental reading (`since` parameter)
- Error handling improvements

### Phase 4: Advanced
- Pane recording
- Synchronized panes
- Session snapshots

## Conclusion

This architecture provides Artie with persistent, observable shell environments through tmux. The design prioritizes simplicity and LLM-friendliness while enabling powerful concurrent workflows.

Key benefits:
- **Stateful execution** - No more losing context between commands
- **Concurrent workflows** - Run multiple tasks in parallel
- **Observable processes** - Inspect running tasks anytime
- **Flexible organization** - Windows and panes for logical grouping

The capability API abstracts tmux complexity while exposing its power, making it natural for an LLM to orchestrate complex development workflows.

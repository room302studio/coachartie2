# Tmux Capability Implementation Guide

## Overview

This document provides technical implementation details for the tmux capability, building on the architecture defined in `TMUX_ARCHITECTURE.md`.

## Prerequisites

### 1. Update Sandbox Container

Modify `docker-compose.yml` to install tmux and configure it:

```yaml
sandbox:
  image: debian:bookworm-slim
  container_name: coachartie-sandbox
  # ... existing config ...
  command: >
    /bin/bash -c "
    apt-get update -qq &&
    apt-get install -y -qq curl wget git jq python3 sqlite3 tmux &&

    # Configure tmux
    cat > /root/.tmux.conf <<'EOF'
    # Increase scrollback
    set -g history-limit 10000

    # Enable mouse support
    set -g mouse on

    # Status bar
    set -g status-style bg=blue,fg=white
    set -g status-left '[Artie] '
    set -g status-right '%H:%M %d-%b'

    # Start windows/panes at 0
    set -g base-index 0
    set -g pane-base-index 0

    # Don't rename windows automatically
    set -g allow-rename off

    # Fix colors
    set -g default-terminal 'screen-256color'
    EOF

    # ... rest of startup script ...
    tail -f /dev/null
    "
```

### 2. Create Capability File

Create `/packages/capabilities/src/capabilities/tmux.ts`:

```typescript
import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

interface TmuxParams {
  action: 'init' | 'send' | 'read' | 'split' | 'list' | 'kill' | 'window';
  pane?: string;
  window?: string;
  command?: string;
  lines?: number;
  all?: boolean;
  since?: boolean;
  direction?: 'horizontal' | 'vertical';
  title?: string;
  cwd?: string;
  name?: string;
  clear?: boolean;
}

// Session name constant
const SESSION_NAME = 'artie';
const CONTAINER_NAME = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';

// Read state tracking
const readStates = new Map<string, { last_line: number; timestamp: Date }>();

export const tmuxCapability: RegisteredCapability = {
  name: 'tmux',
  supportedActions: ['init', 'send', 'read', 'split', 'list', 'kill', 'window'],
  description: 'Manage persistent tmux sessions with multiple panes in the sandbox',
  requiredParams: ['action'],

  handler: async (params: any, _content: string | undefined) => {
    const {
      action,
      pane = '0.0',
      window = '0',
      command,
      lines = 100,
      all = false,
      since = false,
      direction,
      title,
      cwd,
      name,
      clear = false,
    } = params as TmuxParams;

    logger.info(`🖥️  Tmux action: ${action}`, { pane, window });

    try {
      switch (action) {
        case 'init':
          return await handleInit();

        case 'send':
          return await handleSend(pane, command!, clear);

        case 'read':
          return await handleRead(pane, lines, all, since);

        case 'split':
          return await handleSplit(window, direction!, title, cwd);

        case 'list':
          return await handleList();

        case 'kill':
          return await handleKill(pane, window);

        case 'window':
          return await handleWindow(name, cwd);

        default:
          throw new Error(`Unknown tmux action: ${action}`);
      }
    } catch (error: any) {
      logger.error(`❌ Tmux ${action} failed:`, error);
      return formatError(error);
    }
  },
};

/**
 * Execute tmux command in sandbox container
 */
async function tmux(cmd: string, ignoreError = false): Promise<string> {
  const fullCmd = `docker exec ${CONTAINER_NAME} tmux ${cmd}`;
  logger.debug(`Executing: ${fullCmd}`);

  try {
    const { stdout, stderr } = await execAsync(fullCmd, {
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 5, // 5MB
    });

    if (stderr && !ignoreError) {
      logger.warn('tmux stderr:', stderr);
    }

    return stdout.trim();
  } catch (error: any) {
    if (ignoreError) {
      return '';
    }
    throw error;
  }
}

/**
 * Check if session exists
 */
async function sessionExists(): Promise<boolean> {
  try {
    await tmux(`has-session -t ${SESSION_NAME} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure session exists, create if not
 */
async function ensureSession(): Promise<void> {
  if (!(await sessionExists())) {
    logger.info('Creating tmux session:', SESSION_NAME);
    await tmux(`new-session -d -s ${SESSION_NAME} -n workspace -c /workspace`);
  }
}

/**
 * Parse window.pane notation
 */
function parseTarget(target: string): { window: number; pane: number } {
  const [w, p] = target.split('.').map(n => parseInt(n, 10));
  return { window: w, pane: p };
}

/**
 * Format tmux target string
 */
function formatTarget(target: string): string {
  const { window, pane } = parseTarget(target);
  return `${SESSION_NAME}:${window}.${pane}`;
}

/**
 * ACTION: init
 */
async function handleInit() {
  await ensureSession();

  // Get session info
  const windows = await tmux(
    `list-windows -t ${SESSION_NAME} -F '#{window_index}|#{window_name}|#{window_panes}'`
  );

  const windowList = windows.split('\n').map(line => {
    const [id, name, panes] = line.split('|');
    return {
      id: parseInt(id, 10),
      name,
      panes: parseInt(panes, 10),
    };
  });

  return formatSuccess({
    session: SESSION_NAME,
    windows: windowList,
    active_pane: '0.0',
  });
}

/**
 * ACTION: send
 */
async function handleSend(pane: string, command: string, clear: boolean) {
  if (!command) {
    throw new Error('Missing required parameter "command"');
  }

  await ensureSession();

  const target = formatTarget(pane);

  // Clear pane if requested
  if (clear) {
    await tmux(`send-keys -t ${target} C-l`);
  }

  // Send command + Enter
  // Escape single quotes in command
  const escapedCmd = command.replace(/'/g, "'\\''");
  await tmux(`send-keys -t ${target} '${escapedCmd}' Enter`);

  logger.info(`✅ Sent command to ${pane}: ${command.substring(0, 50)}...`);

  return formatSuccess({
    pane,
    command,
    sent_at: new Date().toISOString(),
  });
}

/**
 * ACTION: read
 */
async function handleRead(
  pane: string,
  lines: number,
  all: boolean,
  since: boolean
) {
  await ensureSession();

  const target = formatTarget(pane);
  let startLine = 0;

  if (since) {
    // Read only new output since last read
    const state = readStates.get(pane);
    if (state) {
      startLine = state.last_line;
    }
  }

  // Capture pane output
  let captureCmd = `capture-pane -t ${target} -p`;

  if (all) {
    // Entire scrollback
    captureCmd += ' -S -';
  } else if (since && startLine > 0) {
    // From last position to end
    captureCmd += ` -S ${startLine}`;
  } else {
    // Last N lines
    captureCmd += ` -S -${lines}`;
  }

  const output = await tmux(captureCmd);
  const outputLines = output.split('\n');

  // Update read state
  const totalLines = parseInt(
    await tmux(`display-message -t ${target} -p '#{history_size}'`),
    10
  );

  readStates.set(pane, {
    last_line: totalLines,
    timestamp: new Date(),
  });

  // Get running command
  const currentCmd = await tmux(
    `display-message -t ${target} -p '#{pane_current_command}'`
  );

  return formatSuccess({
    pane,
    output: output.trim(),
    lines_captured: outputLines.length,
    total_lines: totalLines,
    has_more: !all && totalLines > lines,
    current_command: currentCmd,
  });
}

/**
 * ACTION: split
 */
async function handleSplit(
  window: string,
  direction: 'horizontal' | 'vertical',
  title?: string,
  cwd?: string
) {
  await ensureSession();

  const dirFlag = direction === 'vertical' ? '-v' : '-h';
  const cwdFlag = cwd ? `-c ${cwd}` : '';

  // Split creates new pane in specified window
  await tmux(`split-window -t ${SESSION_NAME}:${window} ${dirFlag} ${cwdFlag}`);

  // Get new pane index
  const panes = await tmux(
    `list-panes -t ${SESSION_NAME}:${window} -F '#{pane_index}'`
  );
  const paneList = panes.split('\n').map(p => parseInt(p, 10));
  const newPaneIndex = Math.max(...paneList);
  const newPane = `${window}.${newPaneIndex}`;

  // Set title if provided
  if (title) {
    await tmux(`select-pane -t ${formatTarget(newPane)} -T '${title}'`);
  }

  logger.info(`✅ Created pane ${newPane} (${direction})`);

  return formatSuccess({
    pane: newPane,
    window: parseInt(window, 10),
    direction,
    title: title || '',
    cwd: cwd || '/workspace',
  });
}

/**
 * ACTION: list
 */
async function handleList() {
  await ensureSession();

  const windows = await tmux(
    `list-windows -t ${SESSION_NAME} -F '#{window_index}|#{window_name}'`
  );

  const windowList = [];

  for (const line of windows.split('\n')) {
    const [winId, winName] = line.split('|');

    // Get panes for this window
    const panes = await tmux(
      `list-panes -t ${SESSION_NAME}:${winId} -F '#{pane_index}|#{pane_title}|#{pane_current_path}|#{pane_current_command}|#{pane_active}'`
    );

    const paneList = panes.split('\n').map(pline => {
      const [idx, title, cwd, cmd, active] = pline.split('|');
      return {
        id: `${winId}.${idx}`,
        title,
        cwd,
        running: cmd,
        active: active === '1',
      };
    });

    windowList.push({
      id: parseInt(winId, 10),
      name: winName,
      panes: paneList,
    });
  }

  return formatSuccess({
    session: SESSION_NAME,
    windows: windowList,
  });
}

/**
 * ACTION: kill
 */
async function handleKill(pane?: string, window?: string) {
  await ensureSession();

  if (pane) {
    const target = formatTarget(pane);
    await tmux(`kill-pane -t ${target}`);
    logger.info(`✅ Killed pane ${pane}`);
    return formatSuccess({ killed: pane, type: 'pane' });
  } else if (window) {
    await tmux(`kill-window -t ${SESSION_NAME}:${window}`);
    logger.info(`✅ Killed window ${window}`);
    return formatSuccess({ killed: window, type: 'window' });
  } else {
    throw new Error('Must specify either pane or window to kill');
  }
}

/**
 * ACTION: window
 */
async function handleWindow(name?: string, cwd?: string) {
  await ensureSession();

  const nameFlag = name ? `-n ${name}` : '';
  const cwdFlag = cwd ? `-c ${cwd}` : '-c /workspace';

  await tmux(`new-window -t ${SESSION_NAME} ${nameFlag} ${cwdFlag}`);

  // Get new window index
  const windows = await tmux(
    `list-windows -t ${SESSION_NAME} -F '#{window_index}'`
  );
  const windowList = windows.split('\n').map(w => parseInt(w, 10));
  const newWindow = Math.max(...windowList);

  logger.info(`✅ Created window ${newWindow}: ${name || 'unnamed'}`);

  return formatSuccess({
    window: newWindow,
    name: name || '',
    pane: `${newWindow}.0`,
  });
}

/**
 * Format success response
 */
function formatSuccess(data: any) {
  return JSON.stringify({
    success: true,
    data,
  });
}

/**
 * Format error response
 */
function formatError(error: any) {
  let errorMsg = error.message || String(error);
  let suggestion = '';

  // Provide helpful suggestions
  if (errorMsg.includes("can't find session")) {
    suggestion = 'Run action="init" to create the session first';
  } else if (errorMsg.includes("can't find pane")) {
    suggestion = 'Use action="list" to see available panes';
  } else if (errorMsg.includes("can't find window")) {
    suggestion = 'Use action="list" to see available windows';
  } else if (errorMsg.includes('container not running')) {
    suggestion = 'Start the sandbox: docker-compose up -d sandbox';
  }

  return JSON.stringify({
    success: false,
    error: errorMsg,
    suggestion,
  });
}
```

## 3. Register Capability

Update `/packages/capabilities/src/services/capability-registry.ts`:

```typescript
import { tmuxCapability } from '../capabilities/tmux.js';

// In registerDefaultCapabilities():
registry.register(tmuxCapability);
```

## Testing

### Unit Tests

Create `/packages/capabilities/src/capabilities/tmux.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmuxCapability } from './tmux.js';

describe('Tmux Capability', () => {
  beforeAll(async () => {
    // Ensure sandbox is running
    // Initialize session
    await tmuxCapability.handler({ action: 'init' }, undefined);
  });

  afterAll(async () => {
    // Cleanup
    await tmuxCapability.handler(
      { action: 'kill', window: '0' },
      undefined
    );
  });

  it('should initialize session', async () => {
    const result = await tmuxCapability.handler({ action: 'init' }, undefined);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.session).toBe('artie');
    expect(parsed.data.windows.length).toBeGreaterThan(0);
  });

  it('should send command to pane', async () => {
    const result = await tmuxCapability.handler(
      { action: 'send', pane: '0.0', command: 'echo "test"' },
      undefined
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.command).toBe('echo "test"');
  });

  it('should read pane output', async () => {
    // Send command
    await tmuxCapability.handler(
      { action: 'send', command: 'echo "hello world"' },
      undefined
    );

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));

    // Read output
    const result = await tmuxCapability.handler(
      { action: 'read', pane: '0.0' },
      undefined
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.output).toContain('hello world');
  });

  it('should split pane', async () => {
    const result = await tmuxCapability.handler(
      { action: 'split', window: '0', direction: 'vertical' },
      undefined
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.pane).toMatch(/0\.\d+/);
  });

  it('should list windows and panes', async () => {
    const result = await tmuxCapability.handler({ action: 'list' }, undefined);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.windows).toBeInstanceOf(Array);
    expect(parsed.data.windows.length).toBeGreaterThan(0);
  });

  it('should kill pane', async () => {
    // Create pane
    await tmuxCapability.handler(
      { action: 'split', window: '0', direction: 'horizontal' },
      undefined
    );

    // Kill it
    const result = await tmuxCapability.handler(
      { action: 'kill', pane: '0.1' },
      undefined
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.type).toBe('pane');
  });
});
```

### Integration Tests

Manual testing workflow:

```bash
# 1. Start sandbox
docker-compose up -d sandbox

# 2. Verify tmux is installed
docker exec coachartie-sandbox tmux -V

# 3. Test via API
curl -X POST http://localhost:47324/execute \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "tmux",
    "action": "init"
  }'

# 4. Send command
curl -X POST http://localhost:47324/execute \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "tmux",
    "action": "send",
    "command": "ls -la"
  }'

# 5. Read output
curl -X POST http://localhost:47324/execute \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "tmux",
    "action": "read",
    "pane": "0.0"
  }'
```

## Error Handling

### Session Recovery

If session dies (container restart), auto-recreate:

```typescript
async function ensureSession(): Promise<void> {
  if (!(await sessionExists())) {
    logger.warn('Session not found, creating new one');
    await tmux(`new-session -d -s ${SESSION_NAME} -n workspace -c /workspace`);
  }
}
```

Call `ensureSession()` before every action.

### Container Not Running

```typescript
try {
  await tmux(cmd);
} catch (error: any) {
  if (error.message.includes('container not running')) {
    throw new Error(
      'Sandbox container not running. Start it with: docker-compose up -d sandbox'
    );
  }
  throw error;
}
```

### Invalid Pane Reference

```typescript
try {
  await tmux(`capture-pane -t ${target} -p`);
} catch (error: any) {
  if (error.message.includes("can't find pane")) {
    throw new Error(
      `Pane ${pane} not found. Use action="list" to see available panes.`
    );
  }
  throw error;
}
```

## Performance Considerations

### Command Timeout

Set reasonable timeout for tmux commands:

```typescript
const { stdout } = await execAsync(fullCmd, {
  timeout: 10000, // 10 seconds
  maxBuffer: 5 * 1024 * 1024, // 5MB
});
```

### Output Buffer Limits

Limit scrollback to prevent memory issues:

```bash
# In .tmux.conf
set -g history-limit 10000
```

Limit read lines by default:

```typescript
lines = Math.min(lines, 1000); // Cap at 1000 lines
```

### Caching Read States

Use Map for O(1) lookup:

```typescript
const readStates = new Map<string, ReadState>();

// Clean up old states periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of readStates.entries()) {
    if (now - state.timestamp.getTime() > 3600000) { // 1 hour
      readStates.delete(key);
    }
  }
}, 600000); // Every 10 minutes
```

## Security Considerations

### Command Injection

Escape single quotes in commands:

```typescript
const escapedCmd = command.replace(/'/g, "'\\''");
await tmux(`send-keys -t ${target} '${escapedCmd}' Enter`);
```

### Pane Isolation

Each pane runs in the same container, so there's no isolation between panes. This is acceptable since the entire sandbox is isolated from the host.

### Resource Limits

Rely on container limits:

```yaml
sandbox:
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: '1.0'
```

## Monitoring

### Health Checks

Add tmux session check to sandbox health:

```yaml
sandbox:
  healthcheck:
    test: ["CMD", "tmux", "has-session", "-t", "artie"]
    interval: 60s
    timeout: 5s
    retries: 2
```

### Logging

Log important events:

```typescript
logger.info('🖥️  Tmux session initialized', { session: SESSION_NAME });
logger.info('📤 Sent command to pane', { pane, command: cmd.substring(0, 50) });
logger.warn('⚠️  Session not found, recreating');
logger.error('❌ Tmux command failed', { error: err.message });
```

### Metrics

Track usage:

```typescript
let commandsSent = 0;
let outputBytesRead = 0;
let panesCreated = 0;

// Expose via /metrics endpoint
app.get('/metrics', (req, res) => {
  res.json({
    tmux: {
      commands_sent: commandsSent,
      output_bytes_read: outputBytesRead,
      panes_created: panesCreated,
    },
  });
});
```

## Deployment Checklist

- [ ] Update `docker-compose.yml` to install tmux
- [ ] Add `.tmux.conf` configuration
- [ ] Create `tmux.ts` capability file
- [ ] Register capability in registry
- [ ] Write unit tests
- [ ] Test manually via API
- [ ] Test error cases (session not found, pane not found, etc.)
- [ ] Add logging
- [ ] Update capability documentation
- [ ] Test container restart (session recovery)
- [ ] Verify scrollback limits work
- [ ] Test concurrent pane operations
- [ ] Load test (many panes, large output)
- [ ] Deploy to staging
- [ ] Monitor for errors
- [ ] Deploy to production

## Future Enhancements

### 1. Pane Recording

Continuously save output to files:

```typescript
async function startRecording(pane: string, filepath: string) {
  const target = formatTarget(pane);
  await tmux(`pipe-pane -t ${target} 'cat >> ${filepath}'`);
}
```

### 2. Layout Management

Save and restore pane layouts:

```typescript
async function saveLayout(window: string): Promise<string> {
  return await tmux(`list-windows -t ${SESSION_NAME}:${window} -F '#{window_layout}'`);
}

async function restoreLayout(window: string, layout: string) {
  await tmux(`select-layout -t ${SESSION_NAME}:${window} '${layout}'`);
}
```

### 3. Synchronized Panes

Execute command in all panes:

```typescript
async function syncPanes(window: string, enable: boolean) {
  const flag = enable ? 'on' : 'off';
  await tmux(`setw -t ${SESSION_NAME}:${window} synchronize-panes ${flag}`);
}
```

### 4. Session Templates

Pre-defined session layouts:

```typescript
const templates = {
  'dev': {
    windows: [
      { name: 'code', panes: 1 },
      { name: 'server', panes: 2 },
      { name: 'logs', panes: 1 },
    ],
  },
};

async function createFromTemplate(templateName: string) {
  // Create session with predefined layout
}
```

### 5. Pane Notifications

Alert when pane output matches pattern:

```typescript
async function watchPattern(pane: string, pattern: string, callback: () => void) {
  // Poll pane output for pattern
  // Call callback when found
}
```

## Troubleshooting

### Problem: Session not persisting

**Cause:** Container restart destroys session

**Solution:** Expected behavior. Re-initialize on startup.

### Problem: Pane output truncated

**Cause:** Scrollback limit reached

**Solution:** Increase `history-limit` in `.tmux.conf`

### Problem: Commands not executing

**Cause:** Pane doesn't exist or is hung

**Solution:** List panes, check if target is valid. Kill and recreate if hung.

### Problem: Can't read new output

**Cause:** Read state tracking issue

**Solution:** Use `all=true` to force full read, reset state.

## Conclusion

This implementation provides a robust, production-ready tmux capability for Coach Artie. Key features:

- ✅ Simple API for LLM usage
- ✅ Persistent sessions survive disconnection
- ✅ Concurrent pane management
- ✅ Incremental output reading
- ✅ Comprehensive error handling
- ✅ Production logging and monitoring

The capability enables Artie to manage complex, long-running workflows with multiple concurrent tasks - a significant upgrade from one-shot command execution.

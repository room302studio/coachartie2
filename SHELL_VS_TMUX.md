# Shell vs Tmux: When to Use Each

## Quick Decision Guide

```
Is the command:
├─ Quick (<5 sec) and one-time?
│  → Use shell capability
│
├─ Long-running (server, watcher, build)?
│  → Use tmux capability
│
├─ Need to check on it later?
│  → Use tmux capability
│
├─ Running multiple things concurrently?
│  → Use tmux capability
│
└─ Just need output once?
   └─ Use shell capability
```

## Shell Capability

**Best for:** Quick, one-shot commands that complete and return output.

### Characteristics

- ✅ Simple and fast
- ✅ Synchronous - waits for completion
- ✅ Returns full output immediately
- ❌ No persistence
- ❌ Cannot check on progress
- ❌ Single command at a time
- ❌ Timeout for long-running commands

### Examples

#### List files

```xml
<capability name="shell" command="ls -la /workspace" />
```

**Returns:**

```json
{
  "success": true,
  "data": {
    "stdout": "total 16\ndrwxr-xr-x ...",
    "stderr": "",
    "exit_code": 0
  }
}
```

#### Check git status

```xml
<capability name="shell" command="git status" cwd="/workspace/myproject" />
```

#### Quick calculation

```xml
<capability name="shell" command="echo $((2 + 2))" />
```

#### Get API data

```xml
<capability name="shell" command="curl -s https://api.github.com/repos/owner/repo | jq '.stars'" />
```

## Tmux Capability

**Best for:** Long-running, persistent, or concurrent workflows.

### Characteristics

- ✅ Persistent sessions
- ✅ Multiple panes/windows
- ✅ Asynchronous - command runs in background
- ✅ Can check progress anytime
- ✅ Concurrent execution
- ✅ Interactive programs (REPL, vim, etc.)
- ❌ More complex
- ❌ Requires session management
- ❌ Need separate read to get output

### Examples

#### Run dev server

```xml
<!-- Start server -->
<capability name="tmux" action="send"
  command="npm run dev" />

<!-- Check if it started -->
<capability name="tmux" action="read"
  pane="0.0"
  lines="50" />
```

#### Long-running build

```xml
<!-- Start build -->
<capability name="tmux" action="send"
  command="npm run build" />

<!-- Do other work... -->

<!-- Check build progress -->
<capability name="tmux" action="read" />

<!-- Later: check if done -->
<capability name="tmux" action="read" />
```

#### Monitor logs

```xml
<!-- Create monitoring pane -->
<capability name="tmux" action="split" direction="vertical" />

<!-- Start log watching -->
<capability name="tmux" action="send"
  pane="0.1"
  command="tail -f /var/log/app.log" />

<!-- Read logs anytime -->
<capability name="tmux" action="read" pane="0.1" />
```

## Side-by-Side Comparison

### Scenario 1: Check Node Version

**Shell (Better):**

```xml
<capability name="shell" command="node --version" />
```

✅ Simple, immediate result

**Tmux (Overkill):**

```xml
<capability name="tmux" action="send" command="node --version" />
<capability name="tmux" action="read" pane="0.0" />
```

❌ Unnecessarily complex

**Winner:** Shell

---

### Scenario 2: Run Test Suite

**Shell (Limited):**

```xml
<capability name="shell" command="npm test" timeout="60000" />
```

- ✅ Gets full output
- ❌ Must wait for completion (blocks)
- ❌ Times out if tests take >60s
- ❌ Cannot check progress

**Tmux (Better):**

```xml
<capability name="tmux" action="send" command="npm test" />
<!-- Do other work -->
<capability name="tmux" action="read" lines="50" />
<!-- Check again later -->
<capability name="tmux" action="read" since="true" />
```

- ✅ Doesn't block
- ✅ No timeout (or very long)
- ✅ Can check progress
- ✅ Can read incrementally

**Winner:** Tmux (for slow tests), Shell (for fast tests)

---

### Scenario 3: Git Clone

**Shell (Better for small repos):**

```xml
<capability name="shell"
  command="git clone https://github.com/user/small-repo"
  timeout="30000" />
```

✅ Simple, waits for completion

**Tmux (Better for large repos):**

```xml
<capability name="tmux" action="send"
  command="git clone https://github.com/user/huge-repo" />

<!-- Check progress -->
<capability name="tmux" action="read" />
```

✅ Won't timeout, can monitor progress

**Winner:** Depends on repo size

---

### Scenario 4: Run Multiple Services

**Shell (Impossible):**

```xml
<!-- Can only run one at a time -->
<capability name="shell" command="npm run api" />
<!-- Blocks here, never gets to next -->
<capability name="shell" command="npm run worker" />
```

❌ Second command never runs

**Tmux (Perfect):**

```xml
<capability name="tmux" action="split" direction="vertical" />

<capability name="tmux" action="send"
  pane="0.0"
  command="npm run api" />

<capability name="tmux" action="send"
  pane="0.1"
  command="npm run worker" />

<!-- Both running concurrently -->
<capability name="tmux" action="read" pane="0.0" />
<capability name="tmux" action="read" pane="0.1" />
```

✅ Both services run simultaneously

**Winner:** Tmux (shell can't do this)

---

### Scenario 5: File Search

**Shell (Better):**

```xml
<capability name="shell"
  command="find /workspace -name '*.js' | head -20" />
```

✅ Fast, complete result

**Tmux (Overkill):**

```xml
<capability name="tmux" action="send"
  command="find /workspace -name '*.js'" />
<capability name="tmux" action="read" />
```

❌ Unnecessary complexity

**Winner:** Shell

---

### Scenario 6: Interactive Node REPL

**Shell (Won't work):**

```xml
<capability name="shell" command="node" />
<!-- Can't interact, command never finishes -->
```

❌ Blocks forever

**Tmux (Perfect):**

```xml
<capability name="tmux" action="send" command="node" />

<capability name="tmux" action="send"
  command="const x = 5 + 5" />

<capability name="tmux" action="send"
  command="console.log(x)" />

<capability name="tmux" action="read" />
<!-- Shows: 10 -->

<capability name="tmux" action="send" command=".exit" />
```

✅ Can interact with REPL

**Winner:** Tmux (shell can't do this)

---

### Scenario 7: Database Query

**Shell (Better):**

```xml
<capability name="shell"
  command="sqlite3 /workspace/db.sqlite 'SELECT * FROM users LIMIT 10'" />
```

✅ Simple, immediate result

**Tmux (Overkill):**

```xml
<capability name="tmux" action="send"
  command="sqlite3 /workspace/db.sqlite 'SELECT * FROM users LIMIT 10'" />
<capability name="tmux" action="read" />
```

❌ Unnecessarily complex

**Winner:** Shell

---

### Scenario 8: Watch File Changes

**Shell (Won't work):**

```xml
<capability name="shell" command="watch -n 1 ls -la" />
<!-- Never returns, times out -->
```

❌ Command runs forever

**Tmux (Perfect):**

```xml
<capability name="tmux" action="send"
  command="watch -n 1 ls -la" />

<!-- Check it later -->
<capability name="tmux" action="read" />

<!-- Stop it when done -->
<capability name="tmux" action="send" command="^C" />
```

✅ Runs in background, can check anytime

**Winner:** Tmux (shell can't do this)

## Migration Guide

### When Migrating from Shell to Tmux

If you find yourself:

- Increasing timeout values
- Wanting to run multiple commands concurrently
- Needing to check on command progress
- Running interactive programs
- Starting long-running processes

Then migrate to tmux.

### Pattern Migration

**Before (Shell):**

```xml
<capability name="shell"
  command="npm run build"
  timeout="300000" />
<!-- 5 minute timeout, blocks entire workflow -->
```

**After (Tmux):**

```xml
<capability name="tmux" action="send"
  command="npm run build" />

<!-- Continue with other work -->

<!-- Check build progress later -->
<capability name="tmux" action="read" lines="20" />
```

## Hybrid Workflows

You can use both together effectively.

### Example: Deploy Workflow

```xml
<!-- Use shell for quick checks -->
<capability name="shell" command="git status" />
<capability name="shell" command="git log -1 --oneline" />

<!-- Use tmux for long-running build -->
<capability name="tmux" action="init" />
<capability name="tmux" action="send"
  command="npm run build" />

<!-- Use shell for file operations while building -->
<capability name="shell" command="ls -la dist/" />

<!-- Check build progress -->
<capability name="tmux" action="read" />

<!-- Use shell to verify build output -->
<capability name="shell" command="du -sh dist/" />

<!-- Use tmux to deploy -->
<capability name="tmux" action="send"
  command="npm run deploy" />
```

## Performance Comparison

### Shell

- **Startup:** ~50ms
- **Overhead:** Minimal
- **Blocking:** Yes
- **Concurrent:** No

### Tmux

- **Startup:** ~100ms (first time), ~20ms (session exists)
- **Overhead:** Slight (session management)
- **Blocking:** No
- **Concurrent:** Yes

## Cost-Benefit Analysis

### Shell

**Use when:**

- Command completes in <5 seconds
- You need output immediately
- One command at a time is fine
- No interaction needed

**Benefits:**

- Simple
- Fast
- Less cognitive overhead
- Synchronous flow

### Tmux

**Use when:**

- Command takes >5 seconds
- Need to run multiple things
- Want to check progress
- Interactive program
- Want persistence

**Benefits:**

- Concurrent execution
- No timeouts
- Can monitor progress
- Interactive capabilities
- Session persistence

**Costs:**

- More complex
- Session management
- Asynchronous flow (need separate read)

## Rules of Thumb

### Always Use Shell

- File listing (`ls`, `find`)
- Git status/log
- Package info (`npm list`, `pip list`)
- Quick calculations
- File content (`cat`, `head`)
- Environment checks (`which`, `env`)
- Simple queries
- Version checks

### Always Use Tmux

- Dev servers (`npm run dev`)
- Build processes (`npm run build`)
- Test watchers (`npm test -- --watch`)
- Log monitoring (`tail -f`)
- REPLs (node, python, etc.)
- Interactive editors (vim, nano)
- Multiple concurrent tasks
- Any process you want to keep running

### Context-Dependent

**Small operation → Shell, Large operation → Tmux:**

- Git clone (small repo vs large repo)
- Database operations (single query vs migration)
- File operations (one file vs batch)
- Tests (unit tests vs e2e suite)

## Best Practices

### 1. Start with Shell

If unsure, try shell first:

```xml
<capability name="shell" command="..." />
```

If it times out or blocks workflow, migrate to tmux.

### 2. Don't Overthink

If command finishes quickly, shell is fine. Don't use tmux "just because."

### 3. Clean Up Tmux Sessions

After using tmux, clean up:

```xml
<capability name="tmux" action="kill" pane="0.1" />
```

Don't leave panes running indefinitely.

### 4. Use Descriptive Titles

When using tmux, label panes:

```xml
<capability name="tmux" action="split"
  title="dev-server" />
```

### 5. Check Before Sending

List panes before sending commands:

```xml
<capability name="tmux" action="list" />
```

Know what's running where.

## Conclusion

**Shell and Tmux are complementary, not competing.**

- **Shell:** Quick, synchronous, simple operations
- **Tmux:** Long, asynchronous, complex workflows

Use the right tool for the job. Shell is your screwdriver, tmux is your power drill. Sometimes you need a screwdriver.

### Mental Model

```
Quick task? → Shell
Long task? → Tmux
Multiple tasks? → Tmux
Check progress? → Tmux
Get result once? → Shell
```

That's it. Keep it simple.

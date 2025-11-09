# Tmux Visual Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Coach Artie (LLM)                           │
│                                                                     │
│  "I need to run tests, start dev server, and monitor logs"         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Capability Orchestrator                          │
│                                                                     │
│  Decides: Shell or Tmux?                                            │
│  ├─ Quick command (<5s)? → Shell                                    │
│  └─ Long/concurrent task? → Tmux                                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
    ┌───────────────────┐     ┌───────────────────────┐
    │ Shell Capability  │     │  Tmux Capability      │
    │                   │     │                       │
    │ One-shot exec     │     │ Persistent sessions   │
    │ Returns output    │     │ Multiple panes        │
    │ Blocks until done │     │ Async execution       │
    └─────────┬─────────┘     └──────────┬────────────┘
              │                          │
              │                          │
              ▼                          ▼
    ┌─────────────────────────────────────────────┐
    │     Docker: coachartie-sandbox              │
    │     (Debian container)                      │
    │                                             │
    │  ┌───────────────────────────────────────┐ │
    │  │  Tmux Session: "artie"                │ │
    │  │                                       │ │
    │  │  Window 0: workspace                  │ │
    │  │  ├─ Pane 0.0: npm test --watch        │ │
    │  │  ├─ Pane 0.1: npm run dev             │ │
    │  │  └─ Pane 0.2: tail -f logs.txt        │ │
    │  │                                       │ │
    │  │  Window 1: projects                   │ │
    │  │  ├─ Pane 1.0: git status              │ │
    │  │  └─ Pane 1.1: code analysis           │ │
    │  │                                       │ │
    │  │  Window 2: experiments                │ │
    │  │  └─ Pane 2.0: python REPL             │ │
    │  └───────────────────────────────────────┘ │
    │                                             │
    │  Persistent Volumes:                        │
    │  ├─ /workspace (project files)              │
    │  └─ /root (config, .tmux.conf)              │
    └─────────────────────────────────────────────┘
```

## Capability API Flow

### Shell Capability (Simple)

```
Artie: <capability name="shell" command="ls -la" />
  │
  ▼
docker exec coachartie-sandbox /bin/bash -c "ls -la"
  │
  ▼
[waits for completion]
  │
  ▼
Returns: { stdout: "...", stderr: "", exit_code: 0 }
  │
  ▼
Artie gets result immediately
```

### Tmux Capability (Persistent)

```
Artie: <capability name="tmux" action="send" command="npm test" />
  │
  ▼
docker exec coachartie-sandbox tmux send-keys -t artie:0.0 'npm test' Enter
  │
  ▼
[returns immediately - command runs in background]
  │
  ▼
Returns: { success: true, pane: "0.0", sent_at: "..." }
  │
  ▼
Artie continues with other work...
  │
  ▼
Later: <capability name="tmux" action="read" pane="0.0" />
  │
  ▼
docker exec coachartie-sandbox tmux capture-pane -t artie:0.0 -p
  │
  ▼
Returns: { output: "test results...", lines_captured: 50 }
  │
  ▼
Artie sees test results
```

## Session Structure

```
┌─────────────────────────────────────────────────────────────┐
│ Session: artie                                              │
│ (persistent, survives disconnect)                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Window 0: workspace                                 │   │
│  │                                                     │   │
│  │  ┌──────────────────┬──────────────────┐           │   │
│  │  │ Pane 0.0        │ Pane 0.1        │           │   │
│  │  │                  │                  │           │   │
│  │  │ $ npm test       │ $ npm run dev    │           │   │
│  │  │                  │                  │           │   │
│  │  │ Test output...   │ Server logs...   │           │   │
│  │  │                  │                  │           │   │
│  │  └──────────────────┴──────────────────┘           │   │
│  │  ┌──────────────────────────────────────┐           │   │
│  │  │ Pane 0.2                            │           │   │
│  │  │                                      │           │   │
│  │  │ $ tail -f logs/app.log               │           │   │
│  │  │                                      │           │   │
│  │  │ [2025-11-03] Server started...       │           │   │
│  │  └──────────────────────────────────────┘           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Window 1: projects                                  │   │
│  │                                                     │   │
│  │  ┌──────────────────┬──────────────────┐           │   │
│  │  │ Pane 1.0        │ Pane 1.1        │           │   │
│  │  │                  │                  │           │   │
│  │  │ $ cd project-a   │ $ cd project-b   │           │   │
│  │  │ $ git status     │ $ npm install    │           │   │
│  │  │                  │                  │           │   │
│  │  └──────────────────┴──────────────────┘           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Action Flow Diagram

### Creating and Using Panes

```
Start
  │
  ▼
┌─────────────────┐
│ action="init"   │  Creates session "artie" with window 0, pane 0.0
└────────┬────────┘
         │
         ▼
┌────────────────────┐
│ action="split"     │  Splits 0.0 → creates 0.1
│ direction="vert"   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="split"     │  Splits again → creates 0.2
│ direction="horiz"  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="send"      │  Start test in 0.0
│ pane="0.0"         │
│ cmd="npm test"     │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="send"      │  Start server in 0.1
│ pane="0.1"         │
│ cmd="npm run dev"  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="send"      │  Monitor logs in 0.2
│ pane="0.2"         │
│ cmd="tail -f ..."  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="list"      │  See all panes and what's running
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="read"      │  Check test output
│ pane="0.0"         │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="read"      │  Check server logs
│ pane="0.1"         │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ action="kill"      │  Clean up when done
│ pane="0.2"         │
└────────────────────┘
```

## Data Flow: Reading Incremental Output

```
First Read
──────────
Pane buffer:           State tracking:
┌──────────────┐       ┌──────────────┐
│ Line 1       │       │ pane: "0.0"  │
│ Line 2       │       │ last_line: 0 │
│ Line 3       │       └──────────────┘
│ ...          │              │
│ Line 100     │              │
└──────────────┘              │
      │                       │
      ▼                       ▼
Read all 100 lines    Update: last_line = 100


Second Read (incremental)
────────────────────────
Pane buffer:           State tracking:
┌──────────────┐       ┌──────────────────┐
│ Line 1       │ ◄──── │ pane: "0.0"      │
│ ...          │       │ last_line: 100   │
│ Line 100     │ ◄─┐   └──────────────────┘
│ Line 101     │ ◄─┤   Read from line 100
│ Line 102     │ ◄─┤   (only new content)
│ ...          │ ◄─┘
│ Line 150     │
└──────────────┘
      │
      ▼
Return only lines 101-150
```

## Concurrent Execution Model

```
Traditional Shell (Sequential):
─────────────────────────────
Task A → [======] → Done → Task B → [======] → Done → Task C → [======] → Done
         5 min              5 min              5 min
Total time: 15 minutes


Tmux (Concurrent):
──────────────────
Task A → [======] → Done ┐
         5 min           │
                         ├─→ All done
Task B → [======] → Done ┤
         5 min           │
                         │
Task C → [======] → Done ┘
         5 min

Total time: 5 minutes (all run simultaneously)
```

## Decision Tree

```
                    Need to run command?
                            │
                ┌───────────┴───────────┐
                │                       │
          Quick (<5s)?           Long (>5s)?
                │                       │
                ▼                       ▼
         ┌────────────┐         ┌────────────┐
         │   SHELL    │         │    TMUX    │
         └────────────┘         └────────────┘
                                       │
                          ┌────────────┴────────────┐
                          │                         │
                  Single task?              Multiple tasks?
                          │                         │
                          ▼                         ▼
                   ┌────────────┐          ┌────────────┐
                   │ One pane   │          │Multi-pane  │
                   └────────────┘          └────────────┘
                                                   │
                                      ┌────────────┴────────────┐
                                      │                         │
                              Same project?              Different projects?
                                      │                         │
                                      ▼                         ▼
                              ┌────────────┐          ┌────────────┐
                              │Split panes │          │  Windows   │
                              │in window 0 │          │  0, 1, 2   │
                              └────────────┘          └────────────┘
```

## Error Recovery Flow

```
Action Request
      │
      ▼
┌──────────────┐
│ ensureSession│  Check if session exists
└──────┬───────┘
       │
       ├─ Yes ──────────────────────┐
       │                            │
       └─ No ─→ Create Session ─────┤
                                    │
                                    ▼
                            ┌─────────────┐
                            │Execute Action│
                            └──────┬──────┘
                                   │
                     ┌─────────────┼─────────────┐
                     │             │             │
                 Success      Pane Error    Container Error
                     │             │             │
                     ▼             ▼             ▼
             ┌─────────────┐ ┌──────────┐ ┌──────────────┐
             │Return result│ │List panes│ │Error message │
             └─────────────┘ │suggestion│ │Start sandbox │
                             └──────────┘ └──────────────┘
```

## Memory Model

```
┌─────────────────────────────────────────────────────┐
│ Artie's Memory (LLM Context)                        │
│                                                     │
│ "I have these active panes:                         │
│  - 0.0: Running tests (started 5 min ago)           │
│  - 0.1: Dev server (running on port 3000)           │
│  - 0.2: Watching logs                               │
│                                                     │
│ Last test output showed 2 failures                  │
│ Need to fix and re-run"                             │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
         ┌──────────────────┐
         │ action="read"    │  Check current state
         │ pane="0.0"       │
         └────────┬─────────┘
                  │
                  ▼
         Update understanding
         based on new output
```

## Pane Lifecycle

```
┌────────┐
│ CREATE │  action="split" or action="window"
└───┬────┘
    │
    ▼
┌────────┐
│  IDLE  │  Pane exists, no command running
└───┬────┘  (shows shell prompt)
    │
    │ action="send"
    ▼
┌────────┐
│RUNNING │  Command executing in pane
└───┬────┘  (can read output anytime)
    │
    ├──→ Still running ──┐
    │                    │
    │                    ▼
    │             ┌────────────┐
    │             │  MONITOR   │  Periodic reads
    │             └──────┬─────┘
    │                    │
    │                    └──→ Check again
    │
    │ Command completes
    ▼
┌────────┐
│  DONE  │  Back to IDLE (shell prompt)
└───┬────┘
    │
    │ action="kill"
    ▼
┌────────┐
│DESTROYED│  Pane removed from session
└────────┘
```

## Integration with Existing Architecture

```
┌───────────────────────────────────────────────────────┐
│               Coach Artie System                      │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Discord Bot ──┐                                      │
│  SMS Interface │                                      │
│  Brain UI ─────┼──→ Capability Orchestrator          │
│                │         │                            │
│                │         ├──→ Memory (variable store) │
│                │         ├──→ Calendar               │
│                │         ├──→ Email                  │
│                │         ├──→ GitHub Webhook         │
│                │         ├──→ Shell ←─┐              │
│                │         └──→ Tmux    │              │
│                │                      │              │
│                └──────────────────────┼──────────┐   │
│                                       │          │   │
│                                       ▼          ▼   │
│                          ┌─────────────────────────┐ │
│                          │  Sandbox Container      │ │
│                          │  - Shell execution      │ │
│                          │  - Tmux sessions        │ │
│                          │  - Persistent workspace │ │
│                          └─────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

## Summary Metrics

| Aspect          | Shell          | Tmux                      |
| --------------- | -------------- | ------------------------- |
| **Latency**     | 50ms           | 100ms (init), 50ms (send) |
| **Concurrency** | No             | Yes (unlimited panes)     |
| **Persistence** | No             | Yes (session survives)    |
| **Monitoring**  | No             | Yes (read anytime)        |
| **Complexity**  | Low            | Medium                    |
| **Use Cases**   | Quick commands | Long workflows            |

## Visual Command Reference

```
┌─────────────────────────────────────────────────────┐
│ action="init"                                       │
│ ├─ Creates session "artie"                          │
│ ├─ Creates window 0 "workspace"                     │
│ └─ Creates pane 0.0                                 │
├─────────────────────────────────────────────────────┤
│ action="send" pane="0.0" command="npm test"         │
│ ├─ Sends command to pane                            │
│ ├─ Returns immediately                              │
│ └─ Command runs in background                       │
├─────────────────────────────────────────────────────┤
│ action="read" pane="0.0" lines="100"                │
│ ├─ Captures last 100 lines                          │
│ ├─ Returns output as string                         │
│ └─ Non-destructive (can read again)                 │
├─────────────────────────────────────────────────────┤
│ action="split" window="0" direction="vertical"      │
│ ├─ Splits active pane in window 0                   │
│ ├─ Creates new pane (e.g., 0.1)                     │
│ └─ Both panes visible side-by-side                  │
├─────────────────────────────────────────────────────┤
│ action="list"                                       │
│ ├─ Shows all windows                                │
│ ├─ Shows all panes in each window                   │
│ ├─ Shows running command per pane                   │
│ └─ Shows working directory                          │
├─────────────────────────────────────────────────────┤
│ action="kill" pane="0.1"                            │
│ ├─ Terminates running process                       │
│ ├─ Destroys pane                                    │
│ └─ Cannot kill last pane                            │
├─────────────────────────────────────────────────────┤
│ action="window" name="projects"                     │
│ ├─ Creates new window (e.g., window 1)              │
│ ├─ Creates first pane (1.0)                         │
│ └─ Sets window name                                 │
└─────────────────────────────────────────────────────┘
```

---

**This visual guide complements the detailed documentation:**

- See **TMUX_ARCHITECTURE.md** for complete specifications
- See **TMUX_QUICK_REFERENCE.md** for usage examples
- See **TMUX_IMPLEMENTATION.md** for code details
- See **SHELL_VS_TMUX.md** for decision guidance

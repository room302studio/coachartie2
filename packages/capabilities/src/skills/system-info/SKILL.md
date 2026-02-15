---
name: system-info
description: Get system information like uptime, memory, disk usage
user-invocable: true
emoji: "💻"
command-dispatch: script
command-script: run.sh
actions:
  - status
  - uptime
  - memory
  - disk
requires:
  bins:
    - uptime
    - free
    - df
---

# System Info Skill

Provides system status information including uptime, memory usage, and disk space.

## Actions

- **status**: Full system status overview
- **uptime**: System uptime only
- **memory**: Memory usage details
- **disk**: Disk space usage

## Output Format

Returns human-readable system statistics.

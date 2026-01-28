# GitHub-Discord Sync Feature Plan

## Overview

Keep Discord channels in sync with GitHub repos - surfacing PRs ready for review, comments, CI status, etc. Similar to GitHub's Slack integration, but with Coach Artie's intelligence and judgment.

## Requirements Summary

| Aspect | Decision |
|--------|----------|
| **Trigger** | Polling via existing `GITHUB_TOKEN` - no webhooks needed |
| **Events** | PR opened, ready for review, comments, reviews, approved, changes requested, merged (emphasis on main), CI runs |
| **Channel mapping** | Channel-per-project, multiple repos can feed one channel |
| **Mentions** | Artie figures out GitHub→Discord mappings organically, pings relevant people |
| **Message format** | Artie's judgment - fanfare for big moments, minimal for routine |
| **Filtering** | Affordances to ignore/batch, Artie decides when |
| **Config** | Guild whitelist defaults + database + commands + Artie learning |

## Events to Track

### PR Workflow
- PR opened
- PR ready for review (draft → ready)
- New comments on PRs
- Review comments
- PR approved
- Changes requested
- PR merged (extra emphasis if merged to `main`)

### CI/CD
- GitHub Actions job runs (pass/fail)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub Poller                        │
│  (runs every N minutes, checks configured repos)        │
└─────────────────┬───────────────────────────────────────┘
                  │ new events
                  ▼
┌─────────────────────────────────────────────────────────┐
│               GitHub Sync State (DB)                    │
│  - last seen PR/comment/review per repo                 │
│  - repo → channel mappings                              │
│  - identity mappings (GitHub user → Discord user)       │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│            Event Processor / Batcher                    │
│  - dedup, batch rapid-fire events                       │
│  - filter (drafts, bots, etc.)                          │
│  - enrich with identity lookups                         │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│         Capabilities (optional LLM involvement)         │
│  - format message (judgment on verbosity)               │
│  - decide who to ping                                   │
│  - learn new identity mappings                          │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│                Discord Channel Post                     │
└─────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Database & State ✅
- [x] Add `github_repo_watches` table (repo, channel_id, guild_id, settings)
- [x] Add `github_sync_state` table (repo, last_pr_id, last_comment_id, last_check, etc.)
- [x] Add `github_identity_mappings` table for GitHub username → Discord user mappings
- [x] Add `github_events_queue` table for event batching

### Phase 2: GitHub Poller Service ✅
- [x] Create `/packages/discord/src/services/github-poller.ts`
- [x] Poll repos on configurable interval (3 min default)
- [x] Fetch PRs, comments, reviews, check runs via Octokit
- [x] Compare against sync state, emit new events
- [x] Handle rate limiting with automatic backoff

### Phase 3: Event Processing ✅
- [x] Create `/packages/discord/src/services/github-event-processor.ts`
- [x] Batching logic (5-min window for related events)
- [x] Filtering logic (skip bot PRs, drafts until ready)
- [x] Identity resolution (lookup GitHub→Discord user)
- [x] Event priority calculation

### Phase 4: Discord Posting ✅
- [x] Create `/packages/discord/src/services/github-discord-poster.ts`
- [x] Format messages with rich embeds (color-coded by event type)
- [x] Post to mapped channels
- [x] @ mention resolved Discord users for relevant events
- [x] Extra fanfare for merges to main

### Phase 5: Configuration Layer ✅
- [x] Add `githubSync` to guild whitelist config schema
- [x] `/watch-repo` command to add repo→channel mapping
- [x] `/unwatch-repo` command to remove mapping
- [x] `/list-watches` command to view active watches
- [x] Create `github-sync.ts` orchestrator service

### Phase 6: Identity Learning Capability ✅
- [x] Create `/packages/capabilities/src/capabilities/github-identity.ts`
- [x] Capability for Artie to query GitHub↔Discord mappings
- [x] Capability for Artie to learn/update mappings
- [x] Capability to list/forget mappings

## Key Files to Create/Modify

### New Files
- `/packages/shared/src/db/schema.ts` - Add new tables
- `/packages/discord/src/services/github-poller.ts` - Main poller service
- `/packages/discord/src/services/github-event-processor.ts` - Event batching/filtering
- `/packages/discord/src/services/github-discord-poster.ts` - Discord message formatting
- `/packages/discord/src/commands/watch-repo.ts` - Slash command
- `/packages/discord/src/commands/unwatch-repo.ts` - Slash command
- `/packages/capabilities/src/capabilities/github-identity.ts` - Identity capability

### Modified Files
- `/packages/discord/src/config/guild-whitelist.ts` - Add githubRepos config
- `/packages/discord/src/index.ts` - Initialize poller service
- `/packages/shared/src/services/user-profile.ts` - Extend for GitHub identity

## Configuration Example

```typescript
// In guild-whitelist.ts
{
  id: '123456789',
  type: 'working',
  name: 'Studio Discord',
  githubSync: {
    enabled: true,
    defaultPollIntervalMinutes: 3,
    repos: [
      {
        repo: 'studio/coachartie2',
        channelId: '987654321',
        events: ['pr', 'review', 'ci'], // or 'all'
      },
      {
        repo: 'studio/other-project',
        channelId: '987654321', // same channel, multiple repos
      }
    ]
  }
}
```

## Mention Rules

| Event | Who to Ping |
|-------|-------------|
| PR ready for review | Requested reviewers (if mapped) or @reviewer role |
| Changes requested | PR author |
| PR approved | PR author |
| CI failed | PR author |
| PR merged to main | Celebratory, maybe @channel or custom role |

## Batching Rules

- Comments within 5-minute window on same PR → batch into one message
- Multiple CI runs on same PR → only post final status
- Bot PRs (dependabot, renovate) → skip or minimal notification
- Draft PRs → skip until marked ready

## Notes

- LLM involvement is optional - most logic is deterministic
- Artie can use judgment for message formatting and who to ping
- Identity mappings are learned organically, not required upfront
- All configuration can be adjusted by Artie himself via capabilities

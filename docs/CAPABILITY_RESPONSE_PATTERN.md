# Capability Response Pattern

**CRITICAL DESIGN PRINCIPLE**: Every capability must return rich, verbose, structured data that enables Coach Artie to make precise next-calls without guessing.

## The Golden Rule

> "Return everything the LLM needs to chain the next action without making additional discovery calls."

## Response Structure Template

Every capability response should follow this structure:

```
🎯 [ACTION] COMPLETE

📊 Summary:
- [Key stat 1]: [value]
- [Key stat 2]: [value]
- [Key stat 3]: [value]
- Total [entities]: [count]

📋 [Entity Type] List:
[For each entity returned:]

[Index]. [Entity Name/Title]
   ID: [precise_id_for_next_call]
   [Important Field 1]: [value]
   [Important Field 2]: [value]
   Status: [state_info]

   [Preview/Sample Data - first 200 chars]

   Next Actions:
   - [Action description]: <capability name="[name]" action="[action]" data='{"param":"[EXACT_ID_HERE]"}' />
   - [Action description]: <capability name="[name]" action="[action]" data='{"param":"[EXACT_ID_HERE]"}' />

💡 Recommended Next Steps:
1. [Most common next action with exact syntax]
2. [Alternative next action with exact syntax]

📦 Raw Data (for programmatic access):
[JSON object with all IDs, metrics, and structured data]
```

## Core Principles

### 1. **Always Include IDs**
Every entity mentioned must include its ID for precise next-calls.

❌ Bad: "Found 5 forums"
✅ Good: "Found 5 forums: Bugs (ID: 123), Features (ID: 456), Support (ID: 789)..."

### 2. **Include Counts & Metrics**
Provide aggregate statistics that help the LLM make decisions.

Required metrics:
- Total count
- Active vs archived/locked
- Message/thread counts
- Unique participants
- Time ranges (created, last activity)

### 3. **Provide Preview Data**
Include sample content (first 200 chars) so the LLM can assess relevance without additional calls.

### 4. **Include Exact Next-Call Syntax**
Don't make the LLM guess parameter formats - provide exact XML capability tags.

❌ Bad: "Use the forum ID to list threads"
✅ Good: `<capability name="discord-forums" action="list-threads" data='{"forumId":"123456"}' />`

### 5. **Structure as Both Human & Machine Readable**
- Human-readable summary at top with emojis
- Detailed structured data in middle
- Raw JSON at bottom for programmatic parsing

### 6. **Include State Information**
Always indicate current state so LLM knows what actions are valid.

Examples:
- `Status: 🔒 Locked` (can't post)
- `Status: ✅ Active` (can post)
- `Status: 📦 Archived` (read-only)

## Real-World Examples

### Example 1: discord-forums list-forums

```
🎯 DISCORD FORUMS DISCOVERY COMPLETE

📊 Summary:
- Guild ID: 1420846272545296470
- Total Forums: 3
- Forum Types: GUILD_FORUM

📋 Available Forums:

1. Bugs & Issues
   ID: 1234567890
   Description: Report bugs and technical issues
   Threads: 189
   Tags: bug, critical, ui, backend

   Next Actions:
   - List threads: <capability name="discord-forums" action="list-threads" data='{"forumId":"1234567890"}' />
   - Get summary: <capability name="discord-forums" action="get-forum-summary" data='{"forumId":"1234567890"}' />
   - Sync to GitHub: <capability name="discord-forums" action="sync-to-github" data='{"forumId":"1234567890","repo":"owner/repo"}' />

2. Feature Requests
   ID: 9876543210
   Description: Suggest new features
   Threads: 332
   Tags: enhancement, ui, api

   Next Actions:
   - List threads: <capability name="discord-forums" action="list-threads" data='{"forumId":"9876543210"}' />
   - Get summary: <capability name="discord-forums" action="get-forum-summary" data='{"forumId":"9876543210"}' />
   - Sync to GitHub: <capability name="discord-forums" action="sync-to-github" data='{"forumId":"9876543210","repo":"owner/repo"}' />

💡 Recommended Next Steps:
1. To see all bug discussions:
   <capability name="discord-forums" action="list-threads" data='{"forumId":"1234567890"}' />

2. To get analytics for bugs forum:
   <capability name="discord-forums" action="get-forum-summary" data='{"forumId":"1234567890"}' />

📦 Raw Data (for programmatic access):
{
  "forums": [
    {
      "id": "1234567890",
      "name": "Bugs & Issues",
      "threadCount": 189,
      "tags": ["bug", "critical", "ui", "backend"]
    },
    {
      "id": "9876543210",
      "name": "Feature Requests",
      "threadCount": 332,
      "tags": ["enhancement", "ui", "api"]
    }
  ]
}
```

### Example 2: GitHub sync results

```
🔄 GITHUB SYNC COMPLETE

📊 Sync Summary:
- Forum ID: 1234567890
- Target Repository: myorg/myrepo
- Total Threads Processed: 25
- ✅ Successfully Created: 23
- ❌ Failed: 2
- ⏭️  Skipped (duplicates): 0
- Sync Duration: 45.2s

✅ Successfully Created Issues:
1. Login button not responding on mobile
   Issue URL: https://github.com/myorg/myrepo/issues/142
   Issue Number: #142
   Thread ID: 111111
   Labels: bug, mobile, ui
   State: open

2. Dark mode toggle missing in settings
   Issue URL: https://github.com/myorg/myrepo/issues/143
   Issue Number: #143
   Thread ID: 222222
   Labels: enhancement, ui
   State: open

[... 21 more issues ...]

❌ Failed Issues:
1. Title too long for GitHub
   Thread ID: 333333
   Error: Title exceeds 256 character limit

2. Missing content
   Thread ID: 444444
   Error: No message content found

💡 Next Steps:
- View created issues at: https://github.com/myorg/myrepo/issues
- Review and retry failed syncs

📦 Raw Data (for programmatic access):
{
  "summary": {
    "forumId": "1234567890",
    "repo": "myorg/myrepo",
    "successCount": 23,
    "failureCount": 2,
    "skippedCount": 0,
    "totalProcessed": 25
  },
  "issues": [
    {
      "threadId": "111111",
      "issueNumber": 142,
      "issueUrl": "https://github.com/myorg/myrepo/issues/142",
      "title": "Login button not responding on mobile",
      "success": true
    },
    ...
  ]
}
```

## Anti-Patterns to Avoid

### ❌ Minimal Response
```
"Found 3 forums"
```
**Problem**: No IDs, no counts, no next-call guidance

### ❌ Raw JSON Dump
```json
{"forums": [{"id": 123, "name": "Bugs"}]}
```
**Problem**: Not human-readable, no guidance on next steps

### ❌ Ambiguous References
```
"Use the forum ID from the previous call to list threads"
```
**Problem**: Requires LLM to track state across multiple calls

### ❌ Missing Context
```
"Created 5 issues"
```
**Problem**: No URLs, no success/failure breakdown, no way to verify

## Capability Checklist

Before submitting a capability, verify it returns:

- [ ] **IDs** for every entity that can be referenced in next calls
- [ ] **Counts** for collections (total, active, filtered)
- [ ] **Preview data** for content (first 200 chars)
- [ ] **State indicators** (active/locked/archived/open/closed)
- [ ] **Exact next-call syntax** with real IDs embedded
- [ ] **Human-readable summary** with emojis and structure
- [ ] **Raw JSON** at bottom for programmatic parsing
- [ ] **Error context** when operations fail (what failed, why, how to fix)
- [ ] **Success metrics** for bulk operations (created/updated/failed counts)
- [ ] **URLs** for any created resources (issues, PRs, threads)

## Implementation Pattern

```typescript
async function myCapabilityAction(params: MyParams): Promise<string> {
  // 1. Fetch data from source
  const response = await fetch(...);
  const data = await response.json();

  // 2. Transform into rich summaries with IDs and next-actions
  const summaries = data.items.map(item => ({
    id: item.id,
    name: item.name,
    count: item.count,
    preview: item.content?.substring(0, 200),
    nextActions: {
      viewDetails: `<capability name="my-cap" action="get-details" data='{"id":"${item.id}"}' />`,
      performAction: `<capability name="my-cap" action="do-thing" data='{"id":"${item.id}"}' />`
    }
  }));

  // 3. Calculate aggregate statistics
  const stats = {
    total: summaries.length,
    active: summaries.filter(s => s.status === 'active').length,
    // ... more metrics
  };

  // 4. Build structured response
  return `🎯 [ACTION] COMPLETE

📊 Summary:
- Total Items: ${stats.total}
- Active: ${stats.active}

📋 Items:
${summaries.map((s, i) => `
${i + 1}. ${s.name}
   ID: ${s.id}
   Preview: ${s.preview}

   Next Actions:
   - View: ${s.nextActions.viewDetails}
   - Action: ${s.nextActions.performAction}
`).join('\n')}

💡 Recommended Next Steps:
1. ${summaries[0]?.nextActions.viewDetails || 'N/A'}

📦 Raw Data:
${JSON.stringify(summaries, null, 2)}`;
}
```

## Enforcement

All new capabilities MUST follow this pattern. Code reviews will verify:

1. Response includes all required elements
2. IDs are provided for all entities
3. Next-call syntax is exact and correct
4. Both human and machine formats are present
5. Error messages include actionable guidance

**Remember**: The LLM is only as smart as the data we give it. Rich, structured responses enable intelligent multi-step workflows. Sparse responses force guessing and additional discovery calls.

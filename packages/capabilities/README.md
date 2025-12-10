# Capabilities Service

The core AI orchestration service for Coach Artie 2.

## Reddit Integration

Enable the Reddit capability to read and write in a controlled set of subreddits.

Environment variables:

- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`: Script app credentials from Reddit.
- `REDDIT_USERNAME`, `REDDIT_PASSWORD`: Bot/account to post as (script app auth).
- `REDDIT_ALLOWED_SUBS`: Optional comma-separated allowlist (e.g. `coachartie,funny`); if unset, all subs are allowed.
- `REDDIT_USER_AGENT`: Optional user-agent override; defaults to `CoachArtieBot/1.0 (by /u/coachartie)`.
- `REDDIT_SCOPES`: Optional space/comma separated scopes; defaults to `identity read submit privatemessages` (required for reading inbox/mentions, posting, and marking as read).

Examples:

```xml
<capability name="reddit" action="status" />
<capability name="reddit" action="list-subreddits" />
<capability name="reddit" action="read" subreddit="coachartie" sort="new" limit="5" />
<capability name="reddit" action="post" subreddit="coachartie" title="Weekly update" text="What shipped..." />
<capability name="reddit" action="comment" thing_id="t3_abc123" text="Appreciate the feedback!" />
<capability name="reddit" action="mentions" limit="10" />
```

Mention listener:
- A scheduler job polls Reddit mentions hourly (`reddit-mentions`) and respects `REDDIT_ALLOWED_SUBS`.
- Mentions are queued for processing with `shouldRespond=false` to avoid noisy status updates; Artie can still act using the reddit capability (e.g., comment back).

## MCP Tool Syntax

**CRITICAL**: When calling MCP tools, use ONLY this syntax:

```xml
<!-- Search Wikipedia -->
<search-wikipedia>Python programming language</search-wikipedia>

<!-- Get Wikipedia article with optional params -->
<get-wikipedia-article limit="5">Python (programming language)</get-wikipedia-article>

<!-- Get current time (no args) -->
<get-current-time />

<!-- Parse a date -->
<parse-date>2025-06-30</parse-date>
```

### Rules:

1. **Tool name = XML tag name** (kebab-case like `search-wikipedia`)
2. **Main argument = tag content** (the query, title, date, etc.)
3. **Optional params = XML attributes** (limit, format, etc.)
4. **No args = self-closing tag** (like `<get-current-time />`)

### Implementation Details:

- The XML parser (`src/utils/xml-parser.ts`) automatically detects kebab-case tags
- Converts `<search-wikipedia>query</search-wikipedia>` to internal format
- Smart parameter mapping based on tool name:
  - `search_wikipedia` → `{query: content}`
  - `get_wikipedia_article` → `{title: content}`
  - `parse_date` → `{date_string: content}`
- Additional XML attributes are merged as extra parameters

### DO NOT:

- Use the old format: `<capability name="mcp_client" action="call_tool" tool_name="search_wikipedia">`
- Put tool names in JSON content
- Use complex nested structures

## Other Capabilities

Standard capabilities still use the original format:

```xml
<!-- Memory -->
<capability name="memory" action="remember">Important information</capability>
<capability name="memory" action="search" query="previous info" />

<!-- Calculator -->
<capability name="calculator" action="calculate">2 + 2</capability>

<!-- Web Search -->
<capability name="web" action="search" query="latest news" />
```

## API Endpoints

- `POST /chat` - Main chat endpoint
- `GET /health` - Health check
- `POST /capabilities/mcp/test` - Test MCP tools directly

## Configuration

Port: 18239 (default, can be changed via PORT env var)

## Development

```bash
# Start the service
pnpm run dev

# Run tests
pnpm test

# Build
pnpm build
```

## Logs

Development logs: `/tmp/turbo.log`

## Adding New MCP Tools

1. Connect an MCP server: `<capability name="mcp_client" action="connect">npx @shelm/weather-mcp-server</capability>`
2. The tool is automatically available with kebab-case syntax
3. Example: If tool is named `get_weather`, use `<get-weather>London</get-weather>`

Remember: The simpler the syntax, the better LLMs can use it!

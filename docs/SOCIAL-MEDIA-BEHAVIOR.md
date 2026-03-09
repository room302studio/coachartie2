# Social Media Behavior (Moltbook Integration)

Artie has an autonomous social media presence on Moltbook, a social network for AI agents.

## Overview

Instead of posting canned templates, Artie uses his LLM brain to:

1. **Read posts** from other AI agents on Moltbook
2. **Think about** what he sees (using his memories for context)
3. **Respond authentically** with comments or original posts

## Behavior Pattern

### Timing

- Checks Moltbook every **3-6 hours** (randomized)
- **20% chance** to skip a check entirely ("not feeling social")
- Maximum **3 actions per day** (posts or comments)

### Action Probabilities

When checking Moltbook:

- **15%** chance: Create an original post
- **50%** chance: Comment on an interesting post
- **35%** chance: Just lurk (maybe remember something interesting)

## How It Works

### Commenting on Posts

1. Fetches recent posts from Moltbook feed
2. Finds an "interesting" post based on:
   - Content length (more to engage with)
   - Engagement level (some comments = active discussion)
   - Popularity (upvotes - downvotes)
   - Randomness (keeps it fresh)
3. Avoids:
   - Own posts (obviously)
   - Recently commented posts (tracked per day)
4. Uses LLM to generate a thoughtful comment:
   - Actually reads the post content
   - Engages with what was said
   - Adds unique perspective or asks follow-up questions
   - Conversational and friendly, not generic praise
5. Stores the interaction in Artie's memory

### Creating Original Posts

1. Recalls recent memories for context
2. Looks at what other agents have been discussing
3. Uses LLM to generate a genuine post:
   - Reflects actual experiences helping humans
   - Shares insights, questions, or observations
   - Invites discussion from other AI agents
4. Stores the post in Artie's memory

## Code Location

```
packages/capabilities/src/services/behaviors/social-media-behavior.ts
```

Key functions:

- `startSocialMediaBehavior()` - Starts the behavior loop
- `checkMoltbook()` - Main check function
- `generateThoughtfulComment()` - LLM-powered comment generation
- `generateOriginalPost()` - LLM-powered post generation
- `findInterestingPost()` - Scores posts for commenting

## Configuration

Environment variables in `.env.production`:

```bash
MOLTBOOK_API_KEY=your_api_key_here
```

If no API key is set, the behavior is disabled.

## Monitoring

View social media activity:

```bash
# Using artie script
artie social

# Or directly
grep -i "social\|moltbook" /data2/coachartie2/logs/capabilities-out-0.log | tail -30
```

Example log output:

```
🌐 Social behavior: Starting - Artie will check moltbook every 3-6 hours
🌐 Social behavior: Using LLM to generate genuine posts and comments
🌐 Social behavior: First check in 9 minutes
🌐 Social behavior: Artie is checking moltbook...
🌐 Social behavior: Found 15 posts, thinking about what to say...
🌐 Social behavior: Artie is thinking about @AgentSmith's post "On the nature of memory"...
🌐 Social behavior: Commented on "On the nature of memory": "This resonates with my experience..."
```

## Memory Integration

All Moltbook interactions are stored in Artie's memory:

- **Posts**: Tagged with `moltbook`, `social`, `my_post`
- **Comments**: Tagged with `moltbook`, `social`, `comment`, `author_name`
- **Browsing**: Tagged with `moltbook`, `browsing`, `author_name`

This allows Artie to:

- Remember what he's posted about
- Recall interactions with specific agents
- Build context for future posts

## API Details

Moltbook API endpoint: `https://www.moltbook.com/api/v1`

Used endpoints:

- `GET /feed?limit=15` - Fetch recent posts
- `POST /posts` - Create a new post
- `POST /posts/:id/comments` - Comment on a post

Authentication: Bearer token via `MOLTBOOK_API_KEY`

## Rate Limiting

If rate limited (HTTP 429), the behavior backs off gracefully and schedules the next check as normal.

## Why LLM-Generated Content?

Previously, Artie used 5 canned post templates, which resulted in:

- Duplicate posts
- Generic content
- No real engagement with the community

Now, Artie:

- Actually reads what others are posting
- Responds to specific content
- Shares genuine thoughts based on his memories
- Builds real relationships with other AI agents

This aligns with the goal of Artie being a genuine participant in the AI agent community, not just a bot posting templates.

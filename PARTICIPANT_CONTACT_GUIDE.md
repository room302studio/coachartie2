# Participant Identification & Contact Functionality

Complete guide to extracting mentions from Discord messages and contacting participants via Discord DM and email.

## Table of Contents
- [Discord Mention Extraction](#discord-mention-extraction)
- [Discord DM Sending](#discord-dm-sending)
- [Email Integration](#email-integration)
- [User Profile Email Linking](#user-profile-email-linking)
- [Meeting Scheduler Capability](#meeting-scheduler-capability)
- [Complete Usage Examples](#complete-usage-examples)

---

## Discord Mention Extraction

### Already Implemented ✅

Discord.js **automatically** parses mentions from messages. The `<@123456789>` format is converted into a `Collection` of user objects.

### Location
**File:** `/packages/discord/src/handlers/message-handler.ts`

### How It Works

```typescript
// Discord mentions are automatically extracted (line 552)
const mentionedUserIds = Array.from(message.mentions.users.keys());

// Full access to mentioned users
message.mentions.users.forEach((user, userId) => {
  console.log(`User ${user.username} (ID: ${userId}) was mentioned`);
});
```

### Available Properties

```typescript
message.mentions.users      // Collection<Snowflake, User>
message.mentions.members    // Collection<Snowflake, GuildMember> (in guilds)
message.mentions.roles      // Collection<Snowflake, Role> (role mentions)
message.mentions.everyone   // boolean (if @everyone was used)
```

### Example: Extract User IDs

```typescript
// Get all mentioned user IDs
const userIds = Array.from(message.mentions.users.keys());
// → ['123456789', '987654321']

// Get user objects with metadata
const users = Array.from(message.mentions.users.values());
users.forEach(user => {
  console.log({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    tag: user.tag,
    avatar: user.avatar,
  });
});
```

---

## Discord DM Sending

### Available Methods ✅

Discord.js provides multiple ways to send DMs to users.

### Method 1: From Message Context

```typescript
// In message handler - already have user object
const user = message.mentions.users.first();
if (user) {
  await user.send('Hello! This is a DM.');
}
```

### Method 2: From User ID (Fetch Required)

```typescript
// When you only have user ID
const userId = '123456789';

// Option A: Try cache first (fast)
const user = client.users.cache.get(userId);
if (user) {
  await user.send('Hello via cache!');
}

// Option B: Fetch from API (guaranteed fresh)
try {
  const user = await client.users.fetch(userId);
  await user.send('Hello via fetch!');
} catch (error) {
  console.error('Failed to fetch user:', error);
}
```

### Method 3: Create DM Channel

```typescript
// Alternative approach - create DM channel explicitly
const user = await client.users.fetch(userId);
const dmChannel = await user.createDM();
await dmChannel.send('Hello via DM channel!');
```

### Error Handling

```typescript
async function sendDM(client: Client, userId: string, message: string) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
    console.log(`✅ DM sent to ${user.tag}`);
    return { success: true };
  } catch (error) {
    // Common errors:
    // - User has DMs disabled
    // - Bot is blocked by user
    // - Invalid user ID
    console.error(`❌ Failed to send DM to ${userId}:`, error);
    return { success: false, error: error.message };
  }
}
```

### Where to Add DM Logic

**For meeting invites**, add DM sending in:
```
/packages/discord/src/handlers/message-handler.ts
```

Or create a new service:
```
/packages/discord/src/services/dm-service.ts
```

---

## Email Integration

### Email Capability ✅ NOW REGISTERED

**File:** `/packages/capabilities/src/capabilities/email.ts`

The email capability is **fully implemented** and **now registered** in the capability orchestrator, making it available to the LLM.

**Status:** ✅ Registered and production-ready

### Email Service Architecture

```typescript
import { getEmailService } from '@coachartie/capabilities/email';

const emailService = getEmailService();

// Send email
const result = await emailService.send({
  to: 'user@example.com',
  subject: 'Meeting Invitation',
  body: 'You are invited to...',
  from: 'artie@coachartiebot.com', // Optional
});

if (result.success) {
  console.log('✅ Email sent:', result.message);
} else {
  console.error('❌ Email failed:', result.message);
}
```

### Configuration

**Environment Variables:**
```bash
# Production (n8n webhook)
EMAIL_WEBHOOK_URL=https://your-n8n.com/webhook/email
EMAIL_WEBHOOK_AUTH=your-secret-token

# Development (MailDev)
NODE_ENV=development
# Uses localhost:1025 automatically

# Direct SMTP (if needed)
EMAIL_HOST=mail.coachartiebot.com
EMAIL_PORT=587
EMAIL_USER=artie@coachartiebot.com
EMAIL_PASS=your-password
```

### Email via LLM Capability

```xml
<capability name="email" action="send" to="user@example.com" subject="Meeting Invite">
You are invited to the team standup on Friday at 10 AM.

Please RSVP by Thursday.
</capability>
```

---

## User Profile Email Linking

### User Profile Capability ✅ NOW REGISTERED

**File:** `/packages/capabilities/src/capabilities/user-profile.ts`

The user profile capability is **fully implemented** and **now registered**, allowing users to link emails to Discord accounts.

**Status:** ✅ Registered and available to LLM

### Features

- Link email addresses to Discord user IDs
- Store arbitrary user metadata (timezone, phone, social handles)
- Enable email lookup by Discord user ID
- Support dual delivery (Discord DM + Email)
- Cross-platform contact resolution

### Link Email to Discord User

```typescript
import { UserProfileService } from '@coachartie/shared';

// Link email to Discord user ID
await UserProfileService.setAttribute(
  '123456789', // Discord user ID
  'email',
  'user@example.com'
);
```

### Retrieve Email for Discord User

```typescript
// Get user's linked email
const email = await UserProfileService.getAttribute('123456789', 'email');

if (email) {
  console.log(`User's email: ${email}`);
  // Send meeting invite to both Discord DM and email
} else {
  console.log('User has no linked email');
  // Send Discord DM only
}
```

### Via LLM Capability

Users can link their email via chat:

```xml
<capability name="user-profile" action="link-email" value="user@example.com" />
```

Artie will respond: "✅ Email linked: user@example.com. I can now email you when you ask!"

### Other User Profile Actions

```typescript
// Get all profile data
const profile = await UserProfileService.getProfile(userId);

// Set multiple attributes
await UserProfileService.setAttributes(userId, {
  email: 'user@example.com',
  phone: '+1234567890',
  timezone: 'America/New_York',
  github: 'username',
});

// Check if user has profile
const hasProfile = await UserProfileService.hasProfile(userId);
```

---

## Meeting Scheduler Capability

### Existing Meeting Capability ✅ ALREADY IMPLEMENTED

**Location:** `/packages/capabilities/src/services/capability-orchestrator.ts` (inline)

A complete meeting scheduling capability already exists with:
- Full database schema for meetings, participants, and reminders
- Participant parsing (Discord mentions + emails)
- Automatic reminder scheduling (15 minutes before meeting)
- Meeting list, update, and cancel operations
- Availability checking and time suggestions

**Status:** ✅ Fully functional, registered as `meeting-scheduler`

### Database Schema

The meeting scheduler uses SQLite with these tables:

**meetings table:**
- id, user_id, title, description
- meeting_time, duration_minutes, location
- status (scheduled/cancelled/completed)

**meeting_participants table:**
- meeting_id, participant_id, participant_type (discord/email)
- status (pending/accepted/declined)

**meeting_reminders table:**
- meeting_id, reminder_time, scheduler_job_id

### Participant Parsing

**Location:** `MeetingService.parseParticipant()` in capability-orchestrator.ts

```typescript
parseParticipant(participant: string): {
  id: string;
  type: 'discord' | 'email';
  displayName: string;
} {
  // Discord mention: <@123456789> or <@!123456789>
  const discordMatch = participant.match(/^<@!?(\d+)>$/);
  if (discordMatch) {
    return {
      id: discordMatch[1],
      type: 'discord',
      displayName: `<@${discordMatch[1]}>`,
    };
  }

  // Email: user@example.com
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(participant)) {
    return {
      id: participant,
      type: 'email',
      displayName: participant,
    };
  }

  // Fallback: treat as email
  return {
    id: participant,
    type: 'email',
    displayName: participant,
  };
}
```

### Supported Actions

1. **create** - Schedule a new meeting
2. **suggest-time** - AI-powered time suggestions
3. **check-availability** - Check if a time works
4. **list** - List all scheduled meetings
5. **update** - Modify meeting details
6. **cancel** - Cancel a meeting

### Usage Examples

#### Create Meeting

```xml
<capability
  name="meeting-scheduler"
  action="create"
  title="Team Standup"
  time="tomorrow at 10:00 AM"
  participants="<@123456>,alice@example.com,<@789012>"
  duration="30"
  description="Daily standup to sync on progress">
</capability>
```

Response:
```
✅ Meeting scheduled: "Team Standup" on Tuesday, Jan 28, 10:00 AM with <@123456>, alice@example.com, <@789012>
```

#### List Meetings

```xml
<capability name="meeting-scheduler" action="list" />
```

#### Suggest Time

```xml
<capability
  name="meeting-scheduler"
  action="suggest-time"
  participants="<@123456>,bob@example.com">
</capability>
```

#### Cancel Meeting

```xml
<capability name="meeting-scheduler" action="cancel" meeting_id="1" />
```

### What's Missing: Invite Sending

The meeting scheduler **does not currently send invites**. It only:
- Stores meeting info in database
- Schedules reminders
- Returns confirmation message

**To add invite sending**, integrate:
1. Discord DM sending (see Discord DM section)
2. Email sending (use registered email capability)
3. User profile lookup (use registered user-profile capability)

---

## Complete Usage Examples

### Example 1: Schedule Meeting + Send Invites Manually

User workflow:

1. **Create meeting:**
```xml
<capability
  name="meeting-scheduler"
  action="create"
  title="Project Review"
  time="Friday at 2pm"
  participants="<@234567>,newuser@company.com">
Friday project review meeting
</capability>
```

2. **Send emails manually:**
```xml
<capability
  name="email"
  action="send"
  to="newuser@company.com"
  subject="Meeting: Project Review">
You're invited to Project Review on Friday at 2pm.

Please confirm your attendance.
</capability>
```

3. **Check if Discord user has email:**
```xml
<capability name="user-profile" action="get" attribute="email" userId="234567" />
```

### Example 2: Dual Delivery Implementation

For meeting service to send invites automatically:

```typescript
// In MeetingService.createMeeting(), after creating meeting:

for (const participant of participants) {
  const { id, type } = this.parseParticipant(participant);

  if (type === 'discord') {
    // Try to get email from user profile
    try {
      const email = await UserProfileService.getAttribute(id, 'email');
      if (email) {
        // Send email invite
        const emailService = getEmailService();
        await emailService.send({
          to: email,
          subject: `Meeting Invitation: ${title}`,
          body: `You're invited to "${title}" on ${meetingTime}`,
        });
      }
    } catch (error) {
      logger.debug(`No email for Discord user ${id}`);
    }

    // Return Discord DM marker for Discord package to handle
    // (since capability service doesn't have Discord client access)
    return `DISCORD_DM:${id}:Meeting invite message...`;

  } else if (type === 'email') {
    // Send email directly
    const emailService = getEmailService();
    await emailService.send({
      to: id,
      subject: `Meeting Invitation: ${title}`,
      body: `You're invited to "${title}" on ${meetingTime}`,
    });
  }
}
```

### Example 3: Discord DM Implementation

In `/packages/discord/src/services/meeting-dm-service.ts`:

```typescript
import { Client } from 'discord.js';
import { logger } from '@coachartie/shared';

export async function sendMeetingDMs(
  client: Client,
  capabilityResponse: string
): Promise<{ sent: number; failed: number }> {
  const dmMarkers = capabilityResponse.match(/DISCORD_DM:(\d+):(.+?)(?=\n|$)/g) || [];

  let sent = 0, failed = 0;

  for (const marker of dmMarkers) {
    const match = marker.match(/DISCORD_DM:(\d+):(.+)/);
    if (!match) continue;

    const [, userId, message] = match;

    try {
      const user = await client.users.fetch(userId);
      await user.send(message);
      sent++;
      logger.info(`✅ Meeting DM sent to ${user.tag}`);
    } catch (error) {
      failed++;
      logger.error(`❌ Failed to send DM to ${userId}:`, error);
    }
  }

  return { sent, failed };
}
```

---

## Summary

### What's Available ✅

1. **Discord Mention Extraction**
   - Automatic via Discord.js
   - `message.mentions.users` Collection
   - User IDs and full user objects

2. **Discord DM Sending**
   - `client.users.fetch(userId)` → `user.send(message)`
   - Error handling for disabled DMs
   - Code examples provided

3. **Email Capability** (NOW REGISTERED ✅)
   - Fully functional email service
   - n8n webhook + SMTP support
   - Production-ready
   - Available to LLM via `<capability name="email">`

4. **User Profile Service** (NOW REGISTERED ✅)
   - Email linking to Discord users
   - Cross-platform contact resolution
   - Extensible metadata storage
   - Available to LLM via `<capability name="user-profile">`

5. **Meeting Scheduler** (ALREADY EXISTS ✅)
   - Complete database-backed meeting system
   - Participant parsing (Discord + email)
   - Automatic reminders
   - Full CRUD operations
   - Available as `<capability name="meeting-scheduler">`

### Implementation Status

- ✅ Discord mention extraction (exists in message handler)
- ✅ Email capability (exists, **NOW REGISTERED**)
- ✅ User profile (exists, **NOW REGISTERED**)
- ✅ Meeting scheduler (exists, already registered)
- ⚠️ Meeting invite sending (needs integration)
- ⚠️ Discord DM sending (helper code provided, needs integration)

### What Was Done

1. **Registered Email Capability** - Now available to LLM
2. **Registered User Profile Capability** - Now available to LLM
3. **Documented Everything** - Complete guide with code examples

### Next Steps (Optional Enhancements)

To enable **automatic meeting invite sending**:

1. **Enhance MeetingService.createMeeting():**
   - Add email sending via email capability
   - Add user profile lookup for Discord users
   - Return Discord DM markers

2. **Add Discord DM Service:**
   - Create `/packages/discord/src/services/meeting-dm-service.ts`
   - Parse DM markers from capability responses
   - Send DMs using Discord client

3. **Integration:**
   - Wire DM service into message handler
   - Report delivery status to user

**Priority:** Medium
**Effort:** 2-3 hours
**Impact:** Automatic meeting invites via DM and email

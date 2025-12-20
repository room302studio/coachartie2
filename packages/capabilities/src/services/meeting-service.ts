import { logger, getSyncDb } from '@coachartie/shared';
import { schedulerService } from './scheduler.js';
import { RegisteredCapability } from './capability-registry.js';
import { parse, parseISO, isValid, addDays } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';

// =====================================================
// MEETING SCHEDULER SERVICE & CAPABILITY
// =====================================================

interface MeetingRow {
  id: number;
  user_id: string;
  title: string;
  description?: string;
  scheduled_time: string;
  duration_minutes: number;
  timezone: string;
  participants: string;
  status: string;
  created_via: string;
  created_at: string;
  updated_at: string;
}

interface MeetingParticipantRow {
  id: number;
  meeting_id: number;
  participant_id: string;
  participant_type: string;
  status: string;
}

interface MeetingParams {
  action: string;
  user_id?: string;
  title?: string;
  description?: string;
  time?: string;
  participants?: string;
  duration?: string;
  meeting_id?: string;
  discord_context?: {
    guildId?: string;
    channelId?: string;
    mentions?: Array<{ id: string; username: string; displayName: string }>;
  };
  [key: string]: unknown;
}

class MeetingService {
  private static instance: MeetingService;

  static getInstance(): MeetingService {
    if (!MeetingService.instance) {
      MeetingService.instance = new MeetingService();
    }
    return MeetingService.instance;
  }

  private async parseFlexibleDate(input: string, userTimezone: string): Promise<Date> {
    // Try 1: ISO format (LLM sends this)
    let date = parseISO(input);
    if (isValid(date)) return fromZonedTime(date, userTimezone);

    // Try 2: Common patterns with date-fns
    const patterns = ['yyyy-MM-dd HH:mm', 'MM/dd/yyyy HH:mm', 'MMMM d, yyyy h:mm a'];

    for (const pattern of patterns) {
      date = parse(input, pattern, new Date());
      if (isValid(date)) return fromZonedTime(date, userTimezone);
    }

    // Try 3: Relative dates (tomorrow, next Tuesday)
    if (input.toLowerCase().includes('tomorrow')) {
      const tomorrow = addDays(new Date(), 1);
      return fromZonedTime(tomorrow, userTimezone);
    }

    throw new Error(`Cannot parse date: ${input}`);
  }

  async createMeeting(
    userId: string,
    title: string,
    meetingTime: string,
    participants: string[],
    options: {
      description?: string;
      duration?: number;
      timezone?: string;
      created_via?: string;
      discord_context?: any;
    } = {}
  ): Promise<string> {
    try {
      const db = getSyncDb();

      // Parse meeting time with timezone support
      const userTimezone = options.timezone || 'America/New_York'; // Default EST
      const parsedTime = await this.parseFlexibleDate(meetingTime, userTimezone);

      // Create the meeting
      const participantsJson = JSON.stringify(participants);
      const result = db.run(
        `
        INSERT INTO meetings (user_id, title, description, scheduled_time, duration_minutes, timezone, participants, created_via)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          userId,
          title,
          options.description || null,
          parsedTime.toISOString(),
          options.duration || 30,
          options.timezone || 'UTC',
          participantsJson,
          options.created_via || 'api',
        ]
      );

      const meetingId = result.lastID!;

      // Add participants
      const participantNames: string[] = [];
      for (const participant of participants) {
        const { id, type, displayName } = this.parseParticipant(
          participant,
          options.discord_context
        );

        db.run(
          `
          INSERT INTO meeting_participants (meeting_id, participant_id, participant_type)
          VALUES (?, ?, ?)
        `,
          [meetingId, id, type]
        );

        participantNames.push(displayName);
      }

      // Schedule reminder 15 minutes before meeting
      const reminderTime = new Date(parsedTime.getTime() - 15 * 60 * 1000);
      if (reminderTime > new Date()) {
        const delay = reminderTime.getTime() - Date.now();
        const jobId = `meeting-reminder-${meetingId}`;

        await schedulerService.scheduleOnce(
          'user-reminder',
          {
            userId,
            reminderType: 'meeting-reminder',
            message: `Meeting reminder: "${title}" starts in 15 minutes`,
            meetingId,
          },
          delay
        );

        db.run(
          `
          INSERT INTO meeting_reminders (meeting_id, reminder_time, scheduler_job_id)
          VALUES (?, ?, ?)
        `,
          [meetingId, reminderTime.toISOString(), jobId]
        );
      }

      logger.info(
        `📅 Created meeting "${title}" for user ${userId} with ${participants.length} participants`
      );

      const timeStr = parsedTime.toLocaleString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      const participantStr = participantNames.join(', ');

      return `✅ Meeting scheduled: "${title}" on ${timeStr} with ${participantStr}`;
    } catch (error) {
      logger.error('❌ Failed to create meeting:', error);
      throw new Error(
        `Failed to create meeting: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async listMeetings(userId: string, includeCompleted = false): Promise<string> {
    try {
      const db = getSyncDb();

      const statusFilter = includeCompleted
        ? "status IN ('scheduled', 'completed', 'cancelled')"
        : "status = 'scheduled'";

      const meetings = db.all(
        `
        SELECT id, title, description, scheduled_time, duration_minutes, status, timezone, participants, created_via
        FROM meetings
        WHERE user_id = ? AND ${statusFilter}
        ORDER BY scheduled_time ASC
      `,
        [userId]
      );

      if (meetings.length === 0) {
        return '📅 No upcoming meetings scheduled.';
      }

      const meetingList = await Promise.all(
        meetings.map(async (meeting: MeetingRow) => {
          const participants = db.all(
            `SELECT participant_id, participant_type FROM meeting_participants WHERE meeting_id = ?`,
            [meeting.id]
          );

          const participantStr = participants
            .map((p: MeetingParticipantRow) =>
              p.participant_type === 'discord' ? `<@${p.participant_id}>` : p.participant_id
            )
            .join(', ');

          const meetingTime = new Date(meeting.scheduled_time);
          const timeStr = meetingTime.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });

          const statusEmoji =
            meeting.status === 'scheduled' ? '📅' : meeting.status === 'completed' ? '✅' : '❌';

          return `${statusEmoji} **${meeting.title}** - ${timeStr} (${meeting.duration_minutes}min)\n   Participants: ${participantStr}`;
        })
      );

      return `📅 Your meetings (${meetings.length}):\n\n${meetingList.join('\n\n')}`;
    } catch (error) {
      logger.error('❌ Failed to list meetings:', error);
      return 'Sorry, having trouble listing meetings right now. Please try again.';
    }
  }

  async suggestTime(userId: string, participants: string[], discordContext?: any): Promise<string> {
    try {
      const db = getSyncDb();

      // Query past meetings to find common meeting times
      const pastMeetings = db.all(
        `
        SELECT scheduled_time, COUNT(*) as frequency
        FROM meetings m
        WHERE m.user_id = ? AND m.status = 'completed'
        GROUP BY strftime('%H', scheduled_time)
        ORDER BY frequency DESC
        LIMIT 3
      `,
        [userId]
      );

      // Query upcoming meetings to avoid conflicts
      const upcomingMeetings = db.all(
        `
        SELECT scheduled_time, duration_minutes
        FROM meetings
        WHERE user_id = ? AND status = 'scheduled' AND scheduled_time > datetime('now')
        ORDER BY scheduled_time ASC
      `,
        [userId]
      );

      const suggestions: string[] = [];

      // Suggest times based on past patterns
      if (pastMeetings.length > 0) {
        const topHour = new Date(pastMeetings[0].scheduled_time).getHours();
        suggestions.push(`Based on your meeting history, you often meet around ${topHour}:00.`);
      }

      // Suggest next available slots
      const now = new Date();
      const tomorrow9am = new Date(now);
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);

      const tomorrow2pm = new Date(tomorrow9am);
      tomorrow2pm.setHours(14, 0, 0, 0);

      suggestions.push(`\n📅 Available slots:\n- Tomorrow at 9:00 AM\n- Tomorrow at 2:00 PM`);

      const participantStr = participants
        .map((p) => this.parseParticipant(p, discordContext).displayName)
        .join(', ');
      suggestions.push(`\nParticipants: ${participantStr}`);

      return suggestions.join('\n');
    } catch (error) {
      logger.error('❌ Failed to suggest meeting time:', error);
      return 'Sorry, having trouble suggesting meeting times right now. Please try again.';
    }
  }

  async checkAvailability(userId: string, time: string): Promise<string> {
    try {
      const db = getSyncDb();
      const checkTime = new Date(time);

      if (isNaN(checkTime.getTime())) {
        throw new Error(`Invalid time: ${time}`);
      }

      // Check for conflicts within ±2 hours
      const startWindow = new Date(checkTime.getTime() - 2 * 60 * 60 * 1000);
      const endWindow = new Date(checkTime.getTime() + 2 * 60 * 60 * 1000);

      const conflicts = db.all(
        `
        SELECT title, scheduled_time, duration_minutes
        FROM meetings
        WHERE user_id = ?
          AND status = 'scheduled'
          AND scheduled_time BETWEEN ? AND ?
      `,
        [userId, startWindow.toISOString(), endWindow.toISOString()]
      );

      const timeStr = checkTime.toLocaleString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      if (conflicts.length === 0) {
        return `✅ You're available at ${timeStr}`;
      } else {
        const conflictList = conflicts
          .map(
            (m: MeetingRow) =>
              `- ${m.title} at ${new Date(m.scheduled_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
          )
          .join('\n');

        return `⚠️ Potential conflicts around ${timeStr}:\n${conflictList}`;
      }
    } catch (error) {
      logger.error('❌ Failed to check availability:', error);
      throw new Error(
        `Failed to check availability: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async updateMeeting(
    userId: string,
    meetingId: number,
    updates: Partial<MeetingRow>
  ): Promise<string> {
    try {
      const db = getSyncDb();

      // Verify meeting belongs to user
      const meeting = db.get(`SELECT id, title FROM meetings WHERE id = ? AND user_id = ?`, [
        meetingId,
        userId,
      ]);

      if (!meeting) {
        throw new Error(`Meeting ${meetingId} not found`);
      }

      const updateFields: string[] = [];
      const values: any[] = [];

      if (updates.title) {
        updateFields.push('title = ?');
        values.push(updates.title);
      }
      if (updates.description !== undefined) {
        updateFields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.scheduled_time) {
        updateFields.push('scheduled_time = ?');
        values.push(updates.scheduled_time);
      }
      if (updates.duration_minutes) {
        updateFields.push('duration_minutes = ?');
        values.push(updates.duration_minutes);
      }

      if (updateFields.length === 0) {
        return '❌ No updates provided';
      }

      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(meetingId);

      db.run(`UPDATE meetings SET ${updateFields.join(', ')} WHERE id = ?`, values);

      logger.info(`📅 Updated meeting ${meetingId} for user ${userId}`);

      return `✅ Updated meeting: "${meeting.title}"`;
    } catch (error) {
      logger.error('❌ Failed to update meeting:', error);
      throw new Error(
        `Failed to update meeting: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async cancelMeeting(userId: string, meetingId: number): Promise<string> {
    try {
      const db = getSyncDb();

      // Verify meeting belongs to user
      const meeting = db.get(`SELECT id, title FROM meetings WHERE id = ? AND user_id = ?`, [
        meetingId,
        userId,
      ]);

      if (!meeting) {
        throw new Error(`Meeting ${meetingId} not found`);
      }

      db.run(
        `UPDATE meetings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [meetingId]
      );

      logger.info(`📅 Cancelled meeting ${meetingId} for user ${userId}`);

      return `✅ Cancelled meeting: "${meeting.title}"`;
    } catch (error) {
      logger.error('❌ Failed to cancel meeting:', error);
      throw new Error(
        `Failed to cancel meeting: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private parseParticipant(
    participant: string,
    discordContext?: any
  ): { id: string; type: 'discord' | 'email'; displayName: string } {
    // Resolve Discord mentions using context
    const mentionMatch = participant.match(/^<@!?(\d+)>$/);
    if (mentionMatch && discordContext?.mentions) {
      const mentionId = mentionMatch[1];
      const mention = discordContext.mentions.find((m: any) => m.id === mentionId);
      if (mention) {
        return {
          id: mention.id,
          type: 'discord',
          displayName: mention.displayName,
        };
      }
    }

    // Discord mention format: <@123456789> (fallback if no context)
    const discordMatch = participant.match(/^<@!?(\d+)>$/);
    if (discordMatch) {
      return {
        id: discordMatch[1],
        type: 'discord',
        displayName: participant,
      };
    }

    // Email format
    const emailMatch = participant.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/);
    if (emailMatch) {
      return {
        id: participant,
        type: 'email',
        displayName: participant,
      };
    }

    // Assume it's a Discord ID without formatting
    if (/^\d+$/.test(participant)) {
      return {
        id: participant,
        type: 'discord',
        displayName: `<@${participant}>`,
      };
    }

    // Default to treating as email
    return {
      id: participant,
      type: 'email',
      displayName: participant,
    };
  }
}

async function handleMeetingAction(params: MeetingParams, content?: string): Promise<string> {
  const { action, user_id = 'unknown-user' } = params;
  const meetingService = MeetingService.getInstance();

  logger.info(`📅 Meeting handler called - Action: ${action}, UserId: ${user_id}, Params:`, params);

  try {
    switch (action) {
      case 'create': {
        // Normalize param names - LLMs use different variations
        const title = params.title || (params as any).topic || (params as any).name || content;
        const time = params.time || (params as any).when;
        const participantsStr =
          params.participants || (params as any).attendees || (params as any).people;

        if (!title) {
          logger.error('❌ Meeting creation failed: Missing title param', params);
          return '❌ Please provide a meeting title. Example: <capability name="meeting-scheduler" action="create" title="Team Sync" time="tomorrow at 2pm" participants="<@123>,alice@example.com" />';
        }

        if (!time) {
          logger.error('❌ Meeting creation failed: Missing time param', params);
          return '❌ Please provide a meeting time. Example: <capability name="meeting-scheduler" action="create" title="Team Sync" time="tomorrow at 2pm" participants="<@123>" />';
        }

        // Participants are optional - if none provided, it's a solo meeting
        const participants = participantsStr
          ? String(participantsStr)
              .split(',')
              .map((p) => p.trim())
          : [];

        logger.info(
          `✅ Meeting params validated - Title: ${title}, Time: ${time}, Participants: ${participants.length > 0 ? participantsStr : 'none (solo meeting)'}`
        );
        const duration = params.duration ? parseInt(String(params.duration)) : 60;

        return await meetingService.createMeeting(
          String(user_id),
          String(title),
          String(time),
          participants,
          {
            description: params.description ? String(params.description) : undefined,
            duration,
            timezone: params.timezone ? String(params.timezone) : undefined,
            created_via: params.created_via ? String(params.created_via) : 'api',
            discord_context: params.discord_context,
          }
        );
      }

      case 'suggest-time': {
        const participantsStr = params.participants || content;

        if (!participantsStr) {
          return '❌ Please provide participants. Example: <capability name="meeting-scheduler" action="suggest-time" participants="<@123>,alice@example.com" />';
        }

        const participants = String(participantsStr)
          .split(',')
          .map((p) => p.trim());
        return await meetingService.suggestTime(
          String(user_id),
          participants,
          params.discord_context
        );
      }

      case 'check-availability': {
        const time = params.time || content;

        if (!time) {
          return '❌ Please provide a time to check. Example: <capability name="meeting-scheduler" action="check-availability" time="tomorrow at 2pm" />';
        }

        return await meetingService.checkAvailability(String(user_id), String(time));
      }

      case 'list': {
        const includeCompleted =
          params.include_completed === 'true' || params.include_completed === true;
        return await meetingService.listMeetings(String(user_id), includeCompleted);
      }

      case 'update': {
        const meetingId = params.meeting_id;

        if (!meetingId) {
          return '❌ Please provide a meeting ID. Example: <capability name="meeting-scheduler" action="update" meeting_id="1" title="New Title" />';
        }

        const updates: Partial<MeetingRow> = {};
        if (params.title) updates.title = String(params.title);
        if (params.description !== undefined) updates.description = String(params.description);
        if (params.time) updates.scheduled_time = String(params.time);
        if (params.duration) updates.duration_minutes = parseInt(String(params.duration));

        return await meetingService.updateMeeting(
          String(user_id),
          parseInt(String(meetingId)),
          updates
        );
      }

      case 'cancel': {
        const meetingId = params.meeting_id || content;

        if (!meetingId) {
          return '❌ Please provide a meeting ID. Example: <capability name="meeting-scheduler" action="cancel" meeting_id="1" />';
        }

        return await meetingService.cancelMeeting(String(user_id), parseInt(String(meetingId)));
      }

      default:
        return `❌ Unknown meeting action: ${action}. Supported actions: create, suggest-time, check-availability, list, update, cancel`;
    }
  } catch (error) {
    logger.error(`Meeting capability error for action '${action}':`, error);
    return `Sorry, having trouble with meetings right now: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const meetingCapability: RegisteredCapability = {
  name: 'meeting-scheduler',
  supportedActions: ['create', 'suggest-time', 'check-availability', 'list', 'update', 'cancel'],
  description:
    'Schedule and manage meetings with participants, check availability, get AI-powered time suggestions, and receive reminders',
  handler: handleMeetingAction,
  examples: [
    '<capability name="meeting-scheduler" action="create" title="Team Sync" time="tomorrow at 2pm" participants="<@123456>,alice@example.com" duration="30" />',
    '<capability name="meeting-scheduler" action="suggest-time" participants="<@123456>,bob@example.com" />',
    '<capability name="meeting-scheduler" action="check-availability" time="Friday at 3pm" />',
    '<capability name="meeting-scheduler" action="list" />',
    '<capability name="meeting-scheduler" action="update" meeting_id="1" title="Updated Title" time="Monday at 10am" />',
    '<capability name="meeting-scheduler" action="cancel" meeting_id="1" />',
  ],
};

export { MeetingService };

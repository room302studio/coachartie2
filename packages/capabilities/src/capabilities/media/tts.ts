import { logger, getSyncDb, scrubBlockedUserMentions } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { openRouterService } from '../../services/llm/openrouter.js';

/**
 * TTS capability — Artie speaks out loud via ElevenLabs, posting an mp3
 * voice note to the channel. Voice roster mirrors morningradio's cast so
 * the same characters exist across both systems.
 *
 * Policy: no cloned voices of real people (ElevenLabs ToS + it's just
 * creepy). The roster is stock/designed voices only; new characters get
 * added by dropping a voice ID into VOICES, not by cloning someone.
 */

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

// Same cast as morningradio/synthesize.ts — keep in sync by hand.
const VOICES: Record<string, string> = {
  artie: 'khYwAWwYSjlxlcrwGQ16', // default — same as morningradio "host"
  host: 'khYwAWwYSjlxlcrwGQ16',
  anchor: 'zNsotODqUhvbJ5wMG7Ei', // authoritative archive/newsreel gravitas
  authoritative: 'zNsotODqUhvbJ5wMG7Ei',
  dj: '34lPwSZ54D8fWbX1aHzk',
  poetic: '8quEMRkSpwEaWBzHvTLv',
  field: 'wF1qws7ObfcJCIyAdFai',
  dispatch: 'D9xwB6HNBJ9h4YvQFWuE',
  robot: 'D9xwB6HNBJ9h4YvQFWuE',
  rookie: 'TX3LPaxmHKxFdv7VOQHJ',
  caller: '75DchiXtNUXnu3lra8pV',
};

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.4,
  use_speaker_boost: true,
};

// A voice note is a bit, not an essay. Also caps the ElevenLabs spend per call.
const MAX_TTS_CHARS = 2000;

// ~30 seconds of speech at broadcast pace. The bulletin prompt aims here.
const BULLETIN_WORDS = '80-100';

/**
 * Assemble the raw material for a vibe bulletin: recent channel chatter,
 * guild-wide observational memories, and quick activity stats — straight from
 * the local DB, no Discord API round-trips.
 */
function gatherVibeData(channelId: string, guildId?: string | null) {
  const db = getSyncDb();
  const recent = db.all<{ value: string; created_at: string }>(
    `SELECT value, created_at FROM messages
     WHERE channel_id = ? AND created_at >= datetime('now', '-6 hours')
     ORDER BY created_at DESC LIMIT 50`,
    [channelId]
  );
  const guildMemories = guildId
    ? db.all<{ content: string }>(
        `SELECT content FROM memories
         WHERE guild_id = ? ORDER BY created_at DESC LIMIT 8`,
        [guildId]
      )
    : [];
  const stats = guildId
    ? db.get<{ msgs: number; users: number; channels: number }>(
        `SELECT COUNT(*) AS msgs, COUNT(DISTINCT user_id) AS users,
                COUNT(DISTINCT channel_id) AS channels
         FROM messages WHERE guild_id = ? AND created_at >= datetime('now', '-3 hours')`,
        [guildId]
      )
    : undefined;

  return {
    channelChatter: recent
      .reverse()
      .map((m) => m.value.slice(0, 200))
      .join('\n'),
    guildNotes: guildMemories.map((m) => m.content.slice(0, 250)).join('\n---\n'),
    stats,
  };
}

async function composeBulletin(
  channelId: string,
  guildId: string | null | undefined,
  angle: string | undefined,
  userId: string
): Promise<string> {
  const { channelChatter, guildNotes, stats } = gatherVibeData(channelId, guildId);

  const statsLine = stats
    ? `Guild activity last 3h: ${stats.msgs} messages from ${stats.users} people across ${stats.channels} channels.`
    : '';

  const script = await openRouterService.generateFromMessageChain(
    [
      {
        role: 'system',
        content: `You are Coach Artie, the Subway Builder community's bot, writing the script for a ${BULLETIN_WORDS} word (~30 second) radio bulletin. Lowercase-casual, wry, dense with real specifics — a vibe report, not a news parody.

Cover BOTH: (1) what's actually happening in this channel right now (topics, moods, running bits), (2) the guild as a whole (activity level, anything brewing elsewhere). Use the provided data only; don't invent events. Refer to people sparingly and never @ anyone. If a banned user comes up, call them "the banned one". Output ONLY the spoken script — no stage directions, no headers, no emoji.`,
      },
      {
        role: 'user',
        content: `${angle ? `Requested angle: ${angle}\n\n` : ''}${statsLine}

RECENT CHANNEL MESSAGES (oldest first):
${channelChatter || '(quiet in here)'}

GUILD-WIDE NOTES (observational memory):
${guildNotes || '(none)'}`,
      },
    ],
    userId,
    undefined,
    openRouterService.selectFastModel()
  );

  return script.trim();
}

export const ttsCapability: RegisteredCapability = {
  name: 'tts',
  emoji: '🎙️',
  supportedActions: ['vibe_report', 'speak'],
  description: `Speak out loud: post an mp3 voice note (ElevenLabs) in the current channel.

Actions:
- vibe_report (PREFERRED): a ~30-second info-dense radio bulletin summarizing what's happening in this channel right now AND the guild as a whole. The bulletin writes itself from live channel/guild data — you don't provide the text. Params: voice (optional), angle (optional short steer, e.g. "focus on the linux build drama").
- speak: say specific text you provide (max ${MAX_TTS_CHARS} chars). Params: text, voice, channelId.

Voices: artie (default), anchor (newsreel gravitas), dj, poetic, field, dispatch, robot, rookie, caller.

Use vibe_report whenever someone asks for a voice note, vibe check, "what's happening", a radio bit, or audio in general — it should always carry real information. Use speak only when someone wants specific words said. Don't repeat the audio content in your text reply.`,
  requiredParams: [],
  examples: [
    '<capability name="tts" action="vibe_report" />',
    '<capability name="tts" action="vibe_report" data=\'{"voice":"anchor","angle":"the apology standoff"}\' />',
    '<capability name="tts" action="speak" data=\'{"text":"good morning subway builders, the trains run on time and so do I"}\' />',
  ],

  handler: async (params: any) => {
    const action = params.action || 'vibe_report';
    if (action !== 'speak' && action !== 'vibe_report') {
      return `Unknown action: ${action}. Available: vibe_report, speak`;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return 'TTS unavailable: ELEVENLABS_API_KEY is not configured.';
    }

    const channelId = params.channelId || params.channel_id || params.context?.channelId;
    if (!channelId) {
      return 'No channel to post the voice note in — pass channelId.';
    }

    let text: string;
    if (action === 'vibe_report') {
      try {
        text = await composeBulletin(
          channelId,
          params.guildId || params.guild_id || params.context?.guildId,
          params.angle,
          params.userId || 'vibe-report'
        );
      } catch (error: any) {
        logger.error('Vibe bulletin composition failed:', error);
        return `Couldn't compose the bulletin: ${error.message}`;
      }
    } else {
      text = String(params.text || params.content || '').trim();
    }

    if (!text) {
      return 'Nothing to say — pass text.';
    }
    if (text.length > MAX_TTS_CHARS) {
      text = text.slice(0, MAX_TTS_CHARS);
    }
    // Audio bypasses the discord-side text scrub, so the no-name rule for
    // banned users is enforced here, before synthesis.
    text = scrubBlockedUserMentions(text);

    const voiceName: string = String(params.voice || 'artie').toLowerCase();
    const voiceId = VOICES[voiceName] || VOICES.artie;

    logger.info(`🎙️ TTS ${action}: ${text.length} chars as "${voiceName}" → channel ${channelId}`);

    try {
      const ttsResponse = await fetch(`${ELEVENLABS_API_URL}/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL,
          voice_settings: VOICE_SETTINGS,
        }),
      });

      if (!ttsResponse.ok) {
        const errBody = await ttsResponse.text().catch(() => '');
        logger.error(`ElevenLabs TTS failed: ${ttsResponse.status} ${errBody.slice(0, 200)}`);
        return `TTS failed (${ttsResponse.status}) — probably quota or a bad voice id.`;
      }

      const audio = Buffer.from(await ttsResponse.arrayBuffer());

      const postResponse = await fetch(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileBase64: audio.toString('base64'),
          fileName: action === 'vibe_report' ? 'artie-vibe-report.mp3' : 'artie-voice-note.mp3',
        }),
      });

      if (!postResponse.ok) {
        return `Generated audio but failed to post it (discord service ${postResponse.status}).`;
      }

      return `🎙️ Voice note posted (${text.length} chars, voice: ${voiceName}). Don't repeat the spoken text in your reply.`;
    } catch (error: any) {
      logger.error('TTS capability error:', error);
      return `TTS error: ${error.message}`;
    }
  },
};

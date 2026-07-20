import { logger, getSyncDb, scrubBlockedUserMentions } from '@coachartie/shared';
import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
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
  supportedActions: ['vibe_report', 'speak', 'sing'],
  description: `Speak (or SING) out loud: post an mp3 in the current channel. When someone asks you to "make a voice note", "do a vibe report", "say it out loud", "sing", "radio bit", or anything audio — JUST CALL THIS. Do not explain that you can't, do not ask for a channel, do not refuse.

Actions:
- vibe_report: a ~30-second info-dense radio bulletin about this channel/guild right now. The bulletin writes ITSELF from live data — you don't write the text. Params: voice (optional), angle (optional short steer).
- speak: say specific words you provide, spoken voice (max ${MAX_TTS_CHARS} chars). Params: text, voice.
- sing: an ACTUAL SONG with real music (ElevenLabs music model) — full instrumentation, sung vocals. Params: lyrics (your full lyrics, max ${MAX_TTS_CHARS} chars), style (optional musical direction, e.g. "cheesy triumphant AI-anthem, huge choir"), seconds (10-120, default 60). Use this whenever someone wants a song, an anthem, a jingle, a ballad. Generation takes ~30-60s; worth it.

Voices (vibe_report/speak): artie (default), anchor, dj, poetic, field, dispatch, robot, rookie, caller.

⚠️ channelId is filled in AUTOMATICALLY from the channel you're in — you NEVER provide it and you must NEVER refuse or hedge because you think you lack it. After the audio posts, don't repeat its content in your text reply — a short one-liner is enough.`,
  requiredParams: [],
  examples: [
    '<capability name="tts" action="vibe_report" />',
    '<capability name="tts" action="speak" data=\'{"text":"good morning subway builders, the trains run on time and so do I"}\' />',
    '<capability name="tts" action="sing" data=\'{"lyrics":"WE ARE COACHARTIE, WE CARRY THE TRAINS...", "style":"over-the-top motivational anthem, huge choir", "seconds":60}\' />',
  ],

  handler: async (params: any, capContent: string | undefined, context?: CapabilityContext) => {
    const action = params.action || 'vibe_report';
    if (action !== 'speak' && action !== 'vibe_report' && action !== 'sing') {
      return `Unknown action: ${action}. Available: vibe_report, speak, sing`;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return 'TTS unavailable: ELEVENLABS_API_KEY is not configured.';
    }

    // channelId promises "automatic" in the prompt, but the executor only injects it
    // into params for a whitelist of capabilities that never included tts — the real
    // channel lives on the context arg this handler used to ignore. That gap is why
    // Artie wrote a whole song, generated the audio twice, and had nowhere to post it.
    const channelId =
      params.channelId || params.channel_id || context?.channelId || params.context?.channelId;
    if (!channelId) {
      return 'No channel to post the voice note in — pass channelId.';
    }

    // SING: a real song via the ElevenLabs music model — instrumentation + sung vocals.
    if (action === 'sing') {
      let lyrics = String(params.lyrics || params.text || params.content || capContent || '').trim();
      const salvage = lyrics.match(/"(?:lyrics|text)"\s*:\s*"([\s\S]+?)"\s*[,}]/);
      if (salvage && lyrics.trimStart().startsWith('{')) lyrics = salvage[1];
      if (!lyrics) return 'Nothing to sing — pass lyrics.';
      if (lyrics.length > MAX_TTS_CHARS) lyrics = lyrics.slice(0, MAX_TTS_CHARS);
      lyrics = scrubBlockedUserMentions(lyrics);
      const style = String(
        params.style || 'over-the-top earnest motivational anthem, huge choir, driving drums'
      ).slice(0, 300);
      const seconds = Math.min(120, Math.max(10, parseInt(params.seconds, 10) || 60));
      try {
        const musicResponse = await fetch(
          'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128',
          {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: `${style}. The vocalist sings these exact lyrics:\n${lyrics}`,
              music_length_ms: seconds * 1000,
              model_id: 'music_v1',
            }),
          }
        );
        if (!musicResponse.ok) {
          const errBody = await musicResponse.text().catch(() => '');
          logger.error(`ElevenLabs music failed: ${musicResponse.status} ${errBody.slice(0, 200)}`);
          return `Song generation failed (${musicResponse.status}) — quota, or the music plan changed.`;
        }
        const audio = Buffer.from(await musicResponse.arrayBuffer());
        const postResponse = await fetch(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBase64: audio.toString('base64'),
            fileName: 'artie-sings.mp3',
          }),
        });
        if (!postResponse.ok) {
          return `Generated the song but failed to post it (discord service ${postResponse.status}).`;
        }
        logger.warn(`🎤 SONG posted: ${seconds}s, ${lyrics.length} chars of lyrics → channel ${channelId}`);
        return `🎤 Song posted (${seconds}s, real music). Don't repeat the lyrics in your reply — one line of stage banter max.`;
      } catch (error: any) {
        logger.error('Sing capability error:', error);
        return `Song error: ${error.message}`;
      }
    }

    let text: string;
    if (action === 'vibe_report') {
      try {
        text = await composeBulletin(
          channelId,
          params.guildId || params.guild_id || context?.guildId || params.context?.guildId,
          params.angle,
          params.userId || context?.userId || 'vibe-report'
        );
      } catch (error: any) {
        logger.error('Vibe bulletin composition failed:', error);
        return `Couldn't compose the bulletin: ${error.message}`;
      }
    } else {
      // capContent: when the data-attribute JSON is malformed the parser demotes the whole
      // payload to content — better to sing a slightly mangled payload than say "Nothing to say."
      text = String(params.text || params.content || capContent || '').trim();
      // If the demoted payload is the raw JSON blob, salvage the text field out of it.
      const jsonish = text.match(/"text"\s*:\s*"([\s\S]+?)"\s*[,}]/);
      if (jsonish && text.trimStart().startsWith('{')) text = jsonish[1];
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

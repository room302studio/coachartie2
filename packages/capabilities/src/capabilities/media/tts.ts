import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

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

export const ttsCapability: RegisteredCapability = {
  name: 'tts',
  emoji: '🎙️',
  supportedActions: ['speak'],
  description: `Speak out loud: convert text to speech (ElevenLabs) and post it as an mp3 voice note in the current channel.

Actions:
- speak: Say the given text as audio. Params: text (what to say, max ${MAX_TTS_CHARS} chars), voice (optional: artie, anchor, dj, poetic, field, dispatch, robot, rookie, caller — default artie), channelId (defaults to current channel).

Use when someone asks you to say something out loud, read something aloud, send a voice message/voice note, do a radio bit, or when audio delivery would land better than text (announcements, dramatic readings). Do not narrate that you're doing it — just include a short text intro if needed and speak.`,
  requiredParams: [],
  examples: [
    '<capability name="tts" action="speak" data=\'{"text":"good morning subway builders, the trains run on time and so do I"}\' />',
    '<capability name="tts" action="speak" data=\'{"text":"BREAKING: the C line is late again","voice":"anchor"}\' />',
  ],

  handler: async (params: any) => {
    const action = params.action || 'speak';
    if (action !== 'speak') {
      return `Unknown action: ${action}. Available: speak`;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return 'TTS unavailable: ELEVENLABS_API_KEY is not configured.';
    }

    const text: string = String(params.text || params.content || '').trim();
    if (!text) {
      return 'Nothing to say — pass text.';
    }
    if (text.length > MAX_TTS_CHARS) {
      return `Text too long for a voice note (${text.length} chars, max ${MAX_TTS_CHARS}). Trim it down.`;
    }

    const voiceName: string = String(params.voice || 'artie').toLowerCase();
    const voiceId = VOICES[voiceName] || VOICES.artie;

    const channelId = params.channelId || params.channel_id || params.context?.channelId;
    if (!channelId) {
      return 'No channel to post the voice note in — pass channelId.';
    }

    logger.info(`🎙️ TTS: ${text.length} chars as "${voiceName}" → channel ${channelId}`);

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
          fileName: `artie-voice-note.mp3`,
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

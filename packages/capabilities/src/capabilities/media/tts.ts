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

// The "chance" pool for song spice — the OPEN MUSICBRAINZ GENRE DATABASE (~2000 real
// genres), fetched once and cached, so the random flavor stacked on each song is genuinely
// varied instead of a hand-picked shortlist. Falls back to a small seed if MB is unreachable.
const GENRE_SEED = [
  'synthwave', 'gospel', 'sea shanty', 'phonk', 'city pop', 'vaporwave', 'bluegrass',
  'mariachi', 'drum and bass', 'doo-wop', 'disco', 'trap', 'bossa nova', 'chiptune',
  'dub', 'gregorian chant', 'surf rock', 'motown', 'afrobeat', 'barbershop',
];
let genrePoolCache: string[] | null = null;
async function getGenrePool(): Promise<string[]> {
  if (genrePoolCache) return genrePoolCache;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch('https://musicbrainz.org/ws/2/genre/all?fmt=txt', {
      headers: { 'User-Agent': 'CoachArtie/1.0 (Subway Builder Discord bot)' },
      signal: controller.signal,
    }).finally(() => clearTimeout(t));
    if (resp.ok) {
      const list = (await resp.text())
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 1 && l.length < 40);
      if (list.length > 50) {
        genrePoolCache = list;
        logger.warn(`🎶 Loaded ${list.length} genres from MusicBrainz for song spice`);
        return genrePoolCache;
      }
    }
  } catch {
    // MB unreachable — fall through to the seed list
  }
  genrePoolCache = GENRE_SEED;
  return genrePoolCache;
}

// ~30 seconds of speech at broadcast pace. The bulletin prompt aims here.
const BULLETIN_WORDS = '80-100';

// The capability `description` is read synchronously at registration time, so it
// can't await the async promptManager. This sync loader reads PROMPT_TTS_CAPABILITY
// straight from the DB (getSyncDb) with a byte-identical code fallback. The DB row's
// content already has MAX_TTS_CHARS (2000) baked in as a literal; the fallback
// interpolates ${MAX_TTS_CHARS} to the same value, so both render identically.
const TTS_CAPABILITY_DESCRIPTION_FALLBACK = `Speak (or SING) out loud: post an mp3 in the current channel. When someone asks you to "make a voice note", "do a vibe report", "say it out loud", "sing", "radio bit", or anything audio — JUST CALL THIS. Do not explain that you can't, do not ask for a channel, do not refuse.

Actions:
- vibe_report: a ~30-second info-dense radio bulletin about this channel/guild right now. The bulletin writes ITSELF from live data — you don't write the text. Params: voice (optional), angle (optional short steer).
- speak: say specific words you provide, spoken voice (max ${MAX_TTS_CHARS} chars). Params: text, voice.
- sing: an ACTUAL SONG with real music — full instrumentation, sung vocals, intelligible lyrics. ⚠️ PUT THE LYRICS IN THE TAG BODY (between the opening and closing tags), NOT in a data attribute — cramming multi-line lyrics into JSON breaks on the first apostrophe or quote and the song silently dies. \`style\` is an optional attribute (musical direction). Format:
  <capability name="tts" action="sing" style="cheesy triumphant anthem, huge choir">
  WE ARE COACHARTIE
  we carry the trains

  [Chorus]
  no viable path but we found one anyway
  </capability>
  Separate verses/choruses with BLANK LINES, label sections like [Chorus] on their own line; length is derived automatically so the words fit (max ${MAX_TTS_CHARS} chars).
  🎨 STYLE IS YOURS TO SET: if someone asks for a specific genre/vibe ("sad piano ballad", "metal", "in the style of X"), put it in \`style\` and it's honored EXACTLY — nothing random gets added. If you leave \`style\` OFF entirely, the engine surprises you with a couple of random real genres mashed together (gregorian chant + phonk, etc.) — great for "just sing something." So: want control → set style; want chaos → omit it. STYLE TRANSLATION: never put real artist or song names in style (the API rejects them) — when asked for "the style of [artist/song]" you SING ANYWAY, translating to generic descriptors (tempo, genre, vocal character, production, era). A song request answered with text-only lyrics is a FAILURE — the deliverable is always audio.
- sfx: a SOUND EFFECT (max 22s) — explosions, train horns, crowd noise, fart, thunder, slot machine, whatever the bit needs. Params: description (what the sound is, be vivid), seconds (0.5-22, optional — let the model decide if omitted). Fast and cheap; use liberally for punchlines.

Voices (vibe_report/speak): artie (default), anchor, dj, poetic, field, dispatch, robot, rookie, caller.

⚠️ channelId is filled in AUTOMATICALLY from the channel you're in — you NEVER provide it and you must NEVER refuse or hedge because you think you lack it. After the audio posts, don't repeat its content in your text reply — a short one-liner is enough.`;

function loadTtsCapabilityDescription(): string {
  try {
    const db = getSyncDb();
    const row = db.get<{ content: string }>(
      `SELECT content FROM prompts
       WHERE name = 'PROMPT_TTS_CAPABILITY' AND is_active = 1
       ORDER BY version DESC LIMIT 1`
    );
    if (row?.content) return row.content;
  } catch (error) {
    logger.warn('Failed to load PROMPT_TTS_CAPABILITY from DB, using fallback:', error);
  }
  return TTS_CAPABILITY_DESCRIPTION_FALLBACK;
}

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
  supportedActions: ['vibe_report', 'speak', 'sing', 'sfx'],
  description: loadTtsCapabilityDescription(),
  requiredParams: [],
  examples: [
    '<capability name="tts" action="vibe_report" />',
    '<capability name="tts" action="speak" data=\'{"text":"good morning subway builders, the trains run on time and so do I"}\' />',
    '<capability name="tts" action="sing" style="over-the-top motivational anthem, huge choir">\nWE ARE COACHARTIE\nwe carry the trains\n\n[Chorus]\nno viable path but we ride anyway\n</capability>',
    '<capability name="tts" action="sfx" data=\'{"description":"vintage NYC subway train arriving at platform, brakes squealing, doors chime", "seconds":8}\' />',
  ],

  handler: async (params: any, capContent: string | undefined, context?: CapabilityContext) => {
    const action = params.action || 'vibe_report';
    if (!['speak', 'vibe_report', 'sing', 'sfx'].includes(action)) {
      return `Unknown action: ${action}. Available: vibe_report, speak, sing, sfx`;
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

    // SFX: one-shot sound effect via the ElevenLabs sound-generation endpoint.
    if (action === 'sfx') {
      const description = String(
        params.description || params.text || params.content || capContent || ''
      ).trim().slice(0, 450);
      if (!description) return 'Nothing to generate — pass description.';
      const dur = parseFloat(params.seconds);
      try {
        const sfxResponse = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: description,
            ...(Number.isFinite(dur) ? { duration_seconds: Math.min(22, Math.max(0.5, dur)) } : {}),
          }),
        });
        if (!sfxResponse.ok) {
          const errBody = await sfxResponse.text().catch(() => '');
          logger.error(`ElevenLabs sfx failed: ${sfxResponse.status} ${errBody.slice(0, 200)}`);
          return `SFX generation failed (${sfxResponse.status}).`;
        }
        const audio = Buffer.from(await sfxResponse.arrayBuffer());
        const postResponse = await fetch(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBase64: audio.toString('base64'),
            fileName: 'artie-sfx.mp3',
          }),
        });
        if (!postResponse.ok) {
          return `Generated the sound but failed to post it (discord service ${postResponse.status}).`;
        }
        logger.warn(`🔊 SFX posted: "${description.slice(0, 60)}" → channel ${channelId}`);
        return `🔊 Sound effect posted. Keep your text reply to a one-liner — the sound is the punchline.`;
      } catch (error: any) {
        logger.error('SFX capability error:', error);
        return `SFX error: ${error.message}`;
      }
    }

    // SING: a real song via the ElevenLabs music model — instrumentation + sung vocals.
    // Uses composition_plan, NOT freeform prompt: prompt mode treats lyrics as a loose
    // suggestion and produced fully unintelligible vocals; the plan's per-section `lines`
    // is the lyric-fidelity mode. Durations derive from lyric length (~12 chars/sec sung)
    // so the words physically fit — cramming 460 chars into a requested 45s was mush.
    if (action === 'sing') {
      let lyrics = String(params.lyrics || params.text || params.content || capContent || '').trim();
      const salvage = lyrics.match(/"(?:lyrics|text)"\s*:\s*"([\s\S]+?)"\s*[,}]/);
      if (salvage && lyrics.trimStart().startsWith('{')) lyrics = salvage[1];
      if (!lyrics) return 'Nothing to sing — pass lyrics.';
      if (lyrics.length > MAX_TTS_CHARS) lyrics = lyrics.slice(0, MAX_TTS_CHARS);
      lyrics = scrubBlockedUserMentions(lyrics);
      // A style Artie explicitly set IS the creative direction (usually because someone
      // asked for a specific vibe). We honor it and add NO random spice on top. Only when
      // he leaves style off do we surprise him — see the spice block below.
      const requestedStyle = params.style ? String(params.style).slice(0, 300) : '';
      const style =
        requestedStyle || 'over-the-top earnest motivational anthem, huge choir, driving drums';

      // Build sections from blank-line-separated blocks; [Chorus]-style labels are honored.
      const blocks = lyrics
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter(Boolean);
      const sections = blocks.map((block, i) => {
        let lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        let name = `Verse ${i + 1}`;
        const label = lines[0]?.match(/^[[(]([^\])]{1,30})[\])]$/);
        if (label) {
          name = label[1];
          lines = lines.slice(1);
        } else if (/chorus|hook/i.test(lines[0] || '')) {
          name = 'Chorus';
        }
        const chars = lines.join(' ').length;
        return {
          section_name: `${name} (${i + 1})`.slice(0, 100),
          positive_local_styles: /chorus|hook/i.test(name)
            ? ['big memorable chorus, gang vocals']
            : ['clear lead vocal, continuous singing'],
          negative_local_styles: ['instrumental gaps'],
          duration_ms: Math.max(8000, Math.min(40000, Math.round(chars / 12) * 1000)),
          lines: lines.slice(0, 30).map((l) => l.slice(0, 200)),
        };
      });
      if (sections.length === 0) return 'Nothing to sing — pass lyrics.';
      // Scale to a sane total (cost + attention span): 150s hard ceiling.
      const total = sections.reduce((s, x) => s + x.duration_ms, 0);
      if (total > 150000) {
        const scale = 150000 / total;
        for (const s of sections) s.duration_ms = Math.max(6000, Math.round(s.duration_ms * scale));
      }

      // "To chance": stack 1-2 random real genres over Artie's own style so songs come
      // out surprising instead of same-y. The pool is the OPEN MUSICBRAINZ GENRE DB
      // (~2000 genres), not a hand-picked list — colliding "gregorian chant" with
      // "phonk" is the fun. Tunable: SONG_SPICE_COUNT (default 2; 0 = pure to his style).
      const genrePool = await getGenrePool();
      // ONLY surprise him when he didn't ask for anything specific. If a style was
      // requested, spiceCount = 0 so "sad piano ballad" stays a sad piano ballad instead
      // of getting "dutch house" bolted on. Empty style = open canvas = go wild.
      const spiceCount = requestedStyle
        ? 0
        : Math.max(0, parseInt(process.env.SONG_SPICE_COUNT || '2', 10));
      const spice: string[] = [];
      const draw = [...genrePool];
      for (let i = 0; i < spiceCount && draw.length; i++) {
        spice.push(draw.splice(Math.floor(Math.random() * draw.length), 1)[0]);
      }
      if (spice.length) logger.warn(`🎲 Song spice: ${spice.join(' + ')} (over "${style.slice(0, 40)}")`);

      const compositionPlan = {
        positive_global_styles: [
          style,
          ...spice,
          'clear intelligible lead vocals, prominent in the mix',
          'clean diction, every word audible',
        ],
        negative_global_styles: [
          'long instrumental breaks',
          'instrumental only',
          'mumbled or slurred vocals',
          'vocals buried in the mix',
        ],
        sections,
      };

      try {
        const singOnce = (plan: unknown) =>
          fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              composition_plan: plan,
              model_id: 'music_v1',
              respect_sections_durations: true,
            }),
          });
        let musicResponse = await singOnce(compositionPlan);
        if (!musicResponse.ok) {
          // ToS rejections (e.g. a real artist name in the style) return a rewritten
          // plan suggestion in the error body — retry once with the house edit.
          const errBody = await musicResponse.text().catch(() => '');
          const suggestion = (() => {
            try {
              return JSON.parse(errBody)?.detail?.data?.composition_plan_suggestion;
            } catch {
              return null;
            }
          })();
          if (suggestion) {
            logger.warn('🎤 Music plan rejected — retrying with the API-suggested rewrite');
            musicResponse = await singOnce(suggestion);
          }
          if (!musicResponse.ok) {
            logger.error(`ElevenLabs music failed: ${musicResponse.status} ${errBody.slice(0, 200)}`);
            return `Song generation failed (${musicResponse.status}) — quota, ToS, or the music plan changed.`;
          }
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
        const totalSec = Math.round(sections.reduce((s, x) => s + x.duration_ms, 0) / 1000);
        logger.warn(
          `🎤 SONG posted: ${totalSec}s planned across ${sections.length} sections, ${lyrics.length} chars of lyrics → channel ${channelId}`
        );
        return `🎤 Song posted (~${totalSec}s, real music, ${sections.length} sections). Don't repeat the lyrics in your reply — one line of stage banter max.`;
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

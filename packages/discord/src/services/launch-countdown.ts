/**
 * Steam launch countdown — Sterling Artie's milestone hype posts in #prison.
 *
 * Fires at fixed T-minus marks before the launch instant (see launch-config.ts),
 * generating copy through Artie's own brain (capabilities /chat) with a
 * deterministic template fallback, so a dead LLM or empty completion NEVER
 * results in silence-breaking error text in the channel (the #prison incident
 * rule: on failure, post the template or nothing — never an error).
 *
 * Milestones missed while the bot was offline are skipped once they're stale
 * (no boot-time spam burst), except the launch post itself which stays worth
 * posting for a few hours.
 */

import { Client, ChannelType } from 'discord.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { logger } from '@coachartie/shared';
import {
  STEAM_LAUNCH_AT,
  LAUNCH_CHANNEL_ID,
  formatDelta,
  launchStatusLine,
} from '../config/launch-config.js';
import { violatesOutputSafety } from './user-intent-processor.js';

const CAPABILITIES_URL = process.env.CAPABILITIES_URL || 'http://localhost:47324';
const STEAM_PAGE_URL = process.env.STEAM_PAGE_URL; // optional; never fabricate a link

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

interface Milestone {
  id: string;
  /** ms before launch that this fires (0 = launch instant) */
  offsetMs: number;
  /** how long after its instant the post is still worth making */
  graceMs: number;
  /** deterministic fallback copy; {t} = live countdown string */
  template: string;
}

const MILESTONES: Milestone[] = [
  { id: 't-48h', offsetMs: 48 * HOUR, graceMs: 90 * MINUTE, template:
    `📊 MANDATORY ALL-HANDS, inmates. {t} until Subway Builder hits Steam — Friday, 1:00 PM ET. Corporate sent me down here because you are, statistically, the most passionate userbase I have ever seen. Channel it. Wishlists up. Quotas posted at lights-out. — A. Sterling, CLO` },
  { id: 't-24h', offsetMs: 24 * HOUR, graceMs: 90 * MINUTE, template:
    `☝️ ONE DAY. {t} on the clock. Tomorrow at 1:00 PM ET the turnstiles open and every one of you gets to say you were locked up here when it happened. Regional Manager promotions go to whoever moves the most wishlists tonight. — A. Sterling, CLO` },
  { id: 't-12h', offsetMs: 12 * HOUR, graceMs: 90 * MINUTE, template:
    `🌙 {t} out. Sleep is a pre-launch activity. When you wake up, it's launch day. I've seen a lot of products, champs — I've never seen a platform this ready for a train. 1:00 PM ET. Be there.` },
  { id: 't-6h', offsetMs: 6 * HOUR, graceMs: 60 * MINUTE, template:
    `🚇 {t}. This morning I watched the sun come up over the yard and thought about what we build here: connection. Motion. A city that breathes. Anyway. Wishlists. 1:00 PM ET.` },
  { id: 't-3h', offsetMs: 3 * HOUR, graceMs: 60 * MINUTE, template:
    `⏰ {t}, sales force. Final funnel check: friends notified? Reviews drafted? Clips queued? The number goes up at 1:00 PM ET and you are all — whether you like it or not, and I know you don't — part of the greatest launch team in penal history.` },
  { id: 't-1h', offsetMs: 1 * HOUR, graceMs: 45 * MINUTE, template:
    `🔥 {t}. ONE HOUR. I am not nervous. I have never been nervous in my life. The train is at the platform, killers. 1:00 PM ET.` },
  { id: 't-30m', offsetMs: 30 * MINUTE, graceMs: 25 * MINUTE, template:
    `🚨 {t}. Thirty minutes. Whatever you were doing, it converts worse than this. Get to your stations.` },
  { id: 't-10m', offsetMs: 10 * MINUTE, graceMs: 9 * MINUTE, template:
    `📢 {t}. TEN MINUTES. Standing on the platform. Watching the tunnel. Here it comes.` },
  { id: 'launch', offsetMs: 0, graceMs: 6 * HOUR, template:
    `🎉🚇 THE GAME IS OUT. SUBWAY BUILDER IS LIVE ON STEAM. RIGHT NOW. Years of work just pulled into the station, and you degenerates had front-row seats. Buy it. Review it. Tell everyone you know. This is the proudest day of my corporate life. — A. Sterling, CLO` },
];

// state file lives next to the sqlite db: packages/discord/data/
const STATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/launch-countdown-state.json'
);

interface CountdownState {
  posted: string[];
}

async function loadState(): Promise<CountdownState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8')) as CountdownState;
  } catch {
    return { posted: [] };
  }
}

async function saveState(state: CountdownState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Ask Artie's brain for the hype post in Sterling's voice. Null on any failure. */
async function generateCopy(milestone: Milestone, countdown: string): Promise<string | null> {
  const isLaunch = milestone.id === 'launch';
  const prompt = `You are STERLING ARTIE — Chief Launch Officer for Subway Builder, a slick Don Draper-style marketing exec who cares only about the Steam launch numbers, addressing the rowdy inmates of the #prison Discord channel who begrudgingly love the game. ${
    isLaunch
      ? 'THE GAME JUST LAUNCHED ON STEAM, THIS INSTANT.'
      : `The game launches on Steam in exactly ${countdown} (Friday July 17, 1:00 PM ET — this countdown is precomputed and correct).`
  } Write ONE short hype post (under 700 characters, no preamble, no quotes around it) rallying them: electric excitement, countdown front and center, funnel language, affectionate contempt, sign-off optional. No @everyone/@here. No slurs or hate — sharp but good-natured.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    const res = await fetch(`${CAPABILITIES_URL}/chat?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, userId: 'launch-countdown-scheduler' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string; response?: string };
    const text = typeof data.response === 'string' ? data.response.trim() : '';
    if (data.status !== 'completed' || !text) return null;
    if (text.length > 1500 || violatesOutputSafety(text)) return null;
    return text;
  } catch (error) {
    logger.warn(`Launch countdown: LLM copy generation failed (${milestone.id}):`, error);
    return null;
  }
}

async function postMilestone(client: Client, milestone: Milestone): Promise<boolean> {
  const channel = await client.channels.fetch(LAUNCH_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    logger.warn(`Launch countdown: channel ${LAUNCH_CHANNEL_ID} unavailable`);
    return false;
  }

  const countdown = formatDelta(STEAM_LAUNCH_AT.getTime() - Date.now());
  let text = (await generateCopy(milestone, countdown)) ?? milestone.template.replaceAll('{t}', countdown);
  if (milestone.id === 'launch' && STEAM_PAGE_URL) {
    text += `\n${STEAM_PAGE_URL}`;
  }
  // Final floor check covers the template path too (templates are ours, but cheap insurance).
  if (violatesOutputSafety(text)) return false;

  await channel.send({ content: text.slice(0, 1990), allowedMentions: { parse: [] } });
  logger.info(`🚇 Launch countdown posted: ${milestone.id}`);
  return true;
}

let intervalHandle: NodeJS.Timeout | null = null;

export function initializeLaunchCountdown(client: Client): void {
  if (!launchStatusLine()) {
    logger.info('Launch countdown: launch window over, not starting');
    return;
  }

  let ticking = false;
  const tick = async () => {
    if (ticking) return; // LLM generation can outlast the interval
    ticking = true;
    try {
      const now = Date.now();
      const state = await loadState();
      let dirty = false;

      for (const m of MILESTONES) {
        const fireAt = STEAM_LAUNCH_AT.getTime() - m.offsetMs;
        if (state.posted.includes(m.id) || now < fireAt) continue;
        if (now > fireAt + m.graceMs) {
          // missed while offline — record as skipped so we don't reconsider it
          state.posted.push(m.id);
          dirty = true;
          logger.info(`Launch countdown: skipped stale milestone ${m.id}`);
          continue;
        }
        if (await postMilestone(client, m)) {
          state.posted.push(m.id);
          dirty = true;
        }
        break; // at most one post per tick
      }

      if (dirty) await saveState(state);

      if (state.posted.length === MILESTONES.length && intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('Launch countdown: all milestones done, scheduler stopped');
      }
    } catch (error) {
      logger.warn('Launch countdown tick failed:', error);
    } finally {
      ticking = false;
    }
  };

  intervalHandle = setInterval(tick, MINUTE);
  void tick();
  logger.info(
    `🚇 Launch countdown armed: ${MILESTONES.length} milestones, launch ${STEAM_LAUNCH_AT.toISOString()}`
  );
}

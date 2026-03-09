/**
 * Morning Briefing Capability
 *
 * Daily intelligence briefing compiled from real OSINT data sources
 * and delivered via Discord DM.
 *
 * Data sources:
 *   - Open-Meteo (weather, free API)
 *   - OwnTracks (location context)
 *   - Skywatch (aviation monitoring)
 *   - Countywatch (local news)
 *   - Contractwatch (government spending)
 *   - Donorwatch (campaign finance)
 *   - Anomalywatch (cross-source anomalies)
 *   - Kanban (task board)
 *   - Briefings (latest research memo)
 *   - n8n calendar/email (when configured)
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';
import { schedulerService } from '../../services/core/scheduler.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename } from 'path';

// OSINT database paths
const DB_PATHS = {
  skywatch: '/opt/docker/smallweb/data/skywatch/data/skywatch.db',
  countywatch: '/opt/docker/smallweb/data/countywatch/data/countywatch.db',
  contractwatch: '/opt/docker/smallweb/data/contractwatch/data/contractwatch.db',
  donorwatch: '/opt/docker/smallweb/data/donorwatch/data/donorwatch.db',
  anomalywatch: '/opt/docker/smallweb/data/anomalywatch/data/anomalywatch.db',
  riverwatch: '/opt/docker/smallweb/data/riverwatch/data/riverwatch.db',
  health: '/opt/docker/smallweb/data/health-webhook/data/health.db',
} as const;

const LOCATION_FILE = '/data2/owntracks/location-context.json';
const BRIEFINGS_DIR = '/opt/docker/smallweb/data/briefings/data/reports';

interface BriefingConfig {
  userId: string;
  enabled: boolean;
  cronTime: string;
  timezone: string;
  deliveryChannel: 'discord' | 'sms' | 'both';
  lastDelivered?: string;
}

interface MorningBriefingParams {
  action: string;
  time?: string;
  timezone?: string;
  section?: string;
  channel?: 'discord' | 'sms' | 'both';
  [key: string]: unknown;
}

const briefingConfigs = new Map<string, BriefingConfig>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeToCron(timeStr: string, _timezone: string = 'America/New_York'): string {
  const time = timeStr.toLowerCase().trim();
  let hour = 0;
  let minute = 0;
  const ampmMatch = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (ampmMatch) {
    hour = parseInt(ampmMatch[1]);
    minute = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
    const period = ampmMatch[3];
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
  }
  return `${minute} ${hour} * * *`;
}

/** Run sqlite3 query, return stdout or empty string on error */
function queryDb(dbPath: string, sql: string): string {
  try {
    if (!existsSync(dbPath)) return '';
    return execSync(`sqlite3 "${dbPath}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/** Read a JSON file, return parsed object or null */
function readJson(filePath: string): any {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Section generators — real data, no placeholders
// ---------------------------------------------------------------------------

async function generateWeatherSection(): Promise<string> {
  try {
    const loc = readJson(LOCATION_FILE);
    const lat = loc?.lat || 41.333;
    const lon = loc?.lon || -73.885;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&hourly=precipitation_probability,temperature_2m&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data: any = await resp.json();

    if (!data.current) return '';

    const temp = Math.round(data.current.temperature_2m);
    const wind = Math.round(data.current.wind_speed_10m);
    const code = data.current.weather_code;

    const wxMap: Record<number, string> = {
      0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
      61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow',
      75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers',
      85: 'Snow showers', 95: 'Thunderstorm',
    };
    const wx = wxMap[code] || `WMO ${code}`;

    // Find today's high from remaining hours
    const currentHour = new Date().getHours();
    const remaining = (data.hourly?.temperature_2m || []).slice(currentHour);
    const high = remaining.length > 0 ? Math.round(Math.max(...remaining)) : null;

    // Check for rain
    const rainProbs = (data.hourly?.precipitation_probability || []).slice(currentHour);
    const rainIdx = rainProbs.findIndex((p: number) => p >= 40);
    let rainNote = '';
    if (rainIdx >= 0) {
      const rainHour = currentHour + rainIdx;
      const h = rainHour > 12 ? rainHour - 12 : rainHour;
      const ampm = rainHour >= 12 ? 'pm' : 'am';
      rainNote = ` | Rain ${rainProbs[rainIdx]}% ~${h}${ampm}`;
    }

    let line = `${temp}°F, ${wx}, wind ${wind}mph`;
    if (high !== null) line += ` | High ${high}°F`;
    line += rainNote;

    // Location and sun
    const town = loc?.town?.replace(/^Town of /, '') || 'Putnam Valley';
    const county = loc?.county || 'Putnam';
    const sunrise = loc?.sunset?.sunrise || '';
    const sunset = loc?.sunset?.sunset || '';

    let result = `📍 ${town}, ${county} Co. | ${line}`;
    if (sunrise && sunset) {
      result += `\n☀️ ${sunrise} → ${sunset}`;
    }

    return result;
  } catch (err) {
    logger.warn('Morning briefing weather failed:', err);
    // Fallback: just show location if available
    try {
      const loc = readJson(LOCATION_FILE);
      if (loc) {
        const town = loc?.town?.replace(/^Town of /, '') || 'Putnam Valley';
        return `📍 ${town} (weather unavailable)`;
      }
    } catch { /* ignore */ }
    return '';
  }
}

async function generateCalendarSection(): Promise<string> {
  try {
    const auth = Buffer.from('claude:its-ya-boi-claude-676767').toString('base64');
    const resp = await fetch('http://localhost:5678/webhook/0c8062e4-50b2-4d7e-b93b-9a08e85f7b83', {
      signal: AbortSignal.timeout(5000),
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const data: any = await resp.json();
    // n8n returns either { events: [...] } or a raw array from Google Calendar API
    const rawEvents = Array.isArray(data) ? data : data.events;
    if (!rawEvents || rawEvents.length === 0) return '📅 Calendar: clear day';
    // Filter out Reclaim sync duplicates (they mirror real events)
    const events = rawEvents.filter((e: any) =>
      !(e.source?.title === 'Reclaim Calendar Sync' || e.extendedProperties?.private?.['reclaim.personalSync']));

    // Deduplicate events by summary (handles duplicate calendar entries)
    const seen = new Set<string>();
    const unique = events.filter((e: any) => {
      const key = (e.summary || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const lines = unique.slice(0, 5).map((e: any) => {
      const summary = e.summary || 'Untitled';
      const dt = e.start?.dateTime || e.start || '';
      const timeMatch = String(dt).match(/T(\d{2}):(\d{2})/);
      let timeStr = '?';
      if (timeMatch) {
        const h = parseInt(timeMatch[1]);
        const m = timeMatch[2];
        timeStr = `${h > 12 ? h - 12 : h || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
      }
      return `  · ${timeStr} ${summary}`;
    }).join('\n');
    return `📅 **Calendar** (${unique.length} today)\n${lines}`;
  } catch {
    // Calendar not configured or erroring — silently skip
    return '';
  }
}

async function generateMailSection(): Promise<string> {
  try {
    const auth = Buffer.from('claude:its-ya-boi-claude-676767').toString('base64');
    const resp = await fetch('http://localhost:5678/webhook/eXChuVSVMvtFsN3c/webhook/claude-mail-unread', {
      signal: AbortSignal.timeout(10000),
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const data: any = await resp.json();
    const count = data.count || 0;
    if (count === 0) return '';

    const emails = (data.emails || []).slice(0, 3);
    const lines = emails.map((e: any) => {
      const from = String(e.from || '?').replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
      const subj = String(e.subject || e.snippet || '?').substring(0, 55);
      return `  · ${from.substring(0, 20)} — ${subj}`;
    }).join('\n');
    return `📧 **Mail** (${count} unread)\n${lines}`;
  } catch {
    return '';
  }
}

async function generateSkywatchSection(): Promise<string> {
  const flightCount = queryDb(DB_PATHS.skywatch,
    "SELECT COUNT(*) FROM flights WHERE first_seen >= datetime('now', '-24 hours')");
  const notableCount = queryDb(DB_PATHS.skywatch,
    "SELECT COUNT(*) FROM notable WHERE spotted_at >= datetime('now', '-24 hours')");
  const notableList = queryDb(DB_PATHS.skywatch,
    "SELECT callsign || ' (' || reason || ')' FROM notable WHERE date(spotted_at) >= date('now', '-1 day') GROUP BY callsign ORDER BY MAX(spotted_at) DESC LIMIT 4");

  const nc = parseInt(notableCount) || 0;
  const fc = parseInt(flightCount) || 0;

  if (nc === 0 && fc === 0) return '';

  let result = `✈️ **Skywatch**: ${fc} flights, ${nc} notable`;
  if (notableList) {
    const items = notableList.split('\n').filter(Boolean).map(l => `  · ${l}`);
    result += '\n' + items.join('\n');
  }
  return result;
}

function generateCountySection(): string {
  const newsCount = queryDb(DB_PATHS.countywatch,
    "SELECT COUNT(*) FROM news WHERE first_seen >= datetime('now', '-24 hours')");
  const nc = parseInt(newsCount) || 0;
  if (nc === 0) return '';

  // Prioritize high-signal stories, filter out noise (horoscopes, listicles, routine)
  const topNews = queryDb(DB_PATHS.countywatch,
    `SELECT title FROM news WHERE first_seen >= datetime('now', '-48 hours')
     AND title NOT LIKE '%Horoscope%'
     AND title NOT LIKE '%horoscope%'
     AND title NOT LIKE '%Daily Crossword%'
     AND title NOT LIKE '%Recipe%'
     AND title NOT LIKE '%Best % to Buy%'
     ORDER BY
       CASE WHEN title LIKE '%crash%' OR title LIKE '%plane%' OR title LIKE '%aircraft%'
                 OR title LIKE '%arrest%' OR title LIKE '%fire%' OR title LIKE '%killed%' OR title LIKE '%dead%'
                 OR title LIKE '%emergency%' OR title LIKE '%ICE%' OR title LIKE '%immigration%'
                 OR title LIKE '%shooting%' OR title LIKE '%flood%' OR title LIKE '%evacuate%'
                 OR title LIKE '%explosion%' OR title LIKE '%body%' OR title LIKE '%missing%'
                 OR title LIKE '%indicted%' OR title LIKE '%charged%'
            THEN 0 ELSE 1 END ASC,
       first_seen DESC
     LIMIT 4`);

  let result = `📰 **County** (${nc} new)`;
  if (topNews) {
    const items = topNews.split('\n').filter(Boolean).map(l => {
      const clean = l.replace(/&#\d+;/g, m => String.fromCharCode(parseInt(m.slice(2, -1))))
                     .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      return `  · ${clean.substring(0, 100)}`;
    });
    result += '\n' + items.join('\n');
  }
  return result;
}

function generateContractSection(): string {
  const newContracts = queryDb(DB_PATHS.contractwatch,
    "SELECT COUNT(*) FROM contracts WHERE first_seen >= datetime('now', '-24 hours')");
  const nc = parseInt(newContracts) || 0;
  if (nc === 0) return '';

  const bigContracts = queryDb(DB_PATHS.contractwatch,
    "SELECT agency || ' → ' || recipient_name || ' $' || printf('%.0f', award_amount) FROM contracts WHERE first_seen >= datetime('now', '-24 hours') ORDER BY award_amount DESC LIMIT 2");

  let result = `💰 **Contracts** (${nc} new)`;
  if (bigContracts) {
    const items = bigContracts.split('\n').filter(Boolean).map(l => `  · ${l}`);
    result += '\n' + items.join('\n');
  }
  return result;
}

function generateDonorSection(): string {
  // Only show if there are NEW contributions in the last 24h
  const newToday = queryDb(DB_PATHS.donorwatch,
    "SELECT COUNT(*) FROM contributions WHERE first_seen >= datetime('now', '-24 hours')");
  const nt = parseInt(newToday) || 0;
  if (nt === 0) return ''; // Skip if no new activity

  const bigToday = queryDb(DB_PATHS.donorwatch,
    `SELECT contributor_name || ' → ' || committee_name || ' $' || printf('%.0f', amount)
     FROM contributions WHERE first_seen >= datetime('now', '-24 hours') AND amount >= 500
     ORDER BY amount DESC LIMIT 2`);

  let result = `🗳️ **Donors**: ${nt} new contributions today`;
  if (bigToday) {
    const items = bigToday.split('\n').filter(Boolean).map(l => `  · ${l.substring(0, 90)}`);
    result += '\n' + items.join('\n');
  }
  return result;
}

function generateAnomalySection(): string {
  const anomalies = queryDb(DB_PATHS.anomalywatch,
    `SELECT title || ' [' || printf('%.1f', MAX(final_score)) || ']' FROM signals
     WHERE final_score > 4
     AND ingested_at > datetime('now', '-3 days')
     AND title NOT LIKE '%TEST%'
     AND title NOT LIKE '%OSINT Health%'
     AND title NOT LIKE '%Health Check%'
     AND source NOT LIKE 'osint-health%'
     GROUP BY title ORDER BY MAX(final_score) DESC LIMIT 3`);

  if (!anomalies) return '';

  let result = '⚡ **Anomalies**';
  const items = anomalies.split('\n').filter(Boolean).map(l => `  · ${l}`);
  result += '\n' + items.join('\n');
  return result;
}

function generateTasksSection(): string {
  try {
    // Kanban active cards
    const result = execSync(
      'KANBAN_TOKEN=$(grep API_TOKEN /opt/docker/smallweb/data/kanban/.env 2>/dev/null | cut -d= -f2) && ' +
      'curl -s --max-time 5 "https://kanban.tools.ejfox.com/api/cards" -H "Authorization: Bearer $KANBAN_TOKEN" 2>/dev/null',
      { encoding: 'utf-8', timeout: 10000 }
    );

    const cards = JSON.parse(result || '[]');
    const active = cards.filter((c: any) => c.lane === 'Active').slice(0, 3);
    const blocked = cards.filter((c: any) => c.lane === 'Blocked').slice(0, 2);
    const readyCount = cards.filter((c: any) => c.lane === 'Ready').length;
    const suggested = cards.filter((c: any) => c.lane === 'Suggested').slice(0, 5);

    if (active.length === 0 && blocked.length === 0 && suggested.length === 0) return '';

    let text = '📋 **Tasks**';
    for (const c of active) text += `\n  → ${c.title}`;
    for (const c of blocked) {
      const reason = (c.blocked_reason || c.blockedReason || '').substring(0, 60);
      text += `\n  ⛔ ${c.title}${reason ? ' — ' + reason : ''}`;
    }
    if (readyCount > 0) text += `\n  (${readyCount} ready in backlog)`;
    if (suggested.length > 0) {
      text += `\n\n  💡 **${suggested.length} cards need your review** (Suggested → Ready):`;
      for (const c of suggested) text += `\n  • ${c.title}`;
      text += `\n  → [Review on kanban](https://kanban.tools.ejfox.com)`;
    }
    return text;
  } catch {
    return '';
  }
}

function generateBriefingLink(): string {
  try {
    const latest = execSync(
      `ls -t ${BRIEFINGS_DIR}/*.md 2>/dev/null | head -1`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();

    if (!latest) return '';

    const slug = basename(latest, '.md');
    const title = readFileSync(latest, 'utf-8').split('\n')[0].replace(/^#\s*/, '');
    const ageHours = Math.round((Date.now() - statSync(latest).mtimeMs) / 3600000);

    return `📄 **Latest briefing** (${ageHours}h ago): ${title}\n  → https://briefings.tools.ejfox.com/report/${slug}`;
  } catch {
    return '';
  }
}

function generateHealthSection(): string {
  // Last night's sleep
  const sleep = queryDb(DB_PATHS.health,
    `SELECT json_extract(raw, '$.totalSleep') as total,
            json_extract(raw, '$.deep') as deep,
            json_extract(raw, '$.rem') as rem
     FROM metrics WHERE name='sleep_analysis'
       AND json_extract(raw, '$.totalSleep') >= 2.5
     ORDER BY date DESC LIMIT 1`);

  // 7d sleep avg for context
  const sleepAvg7d = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(json_extract(raw, '$.totalSleep')),1) FROM metrics
     WHERE name='sleep_analysis' AND json_extract(raw, '$.totalSleep') >= 2.5
       AND date >= date('now', '-7 days')`);

  // HRV trend (7d avg vs 30d avg)
  const hrv7d = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(COALESCE(qty,avg)),0) FROM metrics
     WHERE name='heart_rate_variability' AND date >= date('now', '-7 days')`);
  const hrv30d = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(COALESCE(qty,avg)),0) FROM metrics
     WHERE name='heart_rate_variability' AND date >= date('now', '-30 days')`);

  // Resting HR
  const rhr = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(qty),0) FROM metrics
     WHERE name='resting_heart_rate' AND date >= date('now', '-3 days')`);

  // Yesterday's steps + 7d avg for context
  const steps = queryDb(DB_PATHS.health,
    `SELECT ROUND(SUM(qty)) FROM metrics
     WHERE name='step_count'
       AND date(date) = (SELECT MAX(date(date)) FROM metrics WHERE name='step_count' AND date(date) < date('now'))`);
  const stepsAvg7d = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(daily_steps)) FROM (
       SELECT date(date) as d, SUM(qty) as daily_steps FROM metrics
       WHERE name='step_count' AND date >= date('now', '-7 days')
       GROUP BY date(date)
     )`);

  // Yesterday's interventions
  const interventions = queryDb(DB_PATHS.health,
    `SELECT substance || COALESCE(' ' || CAST(CAST(dose AS INT) AS TEXT) || unit, '')
     FROM interventions
     WHERE date(timestamp) = date('now', '-1 day')
     ORDER BY timestamp`);

  if (!sleep && !hrv7d && !steps) return '';

  let result = '🏥 **Health**';

  if (sleep) {
    const parts = sleep.split('|');
    const total = parseFloat(parts[0]) || 0;
    const deep = parseFloat(parts[1]) || 0;
    const rem = parseFloat(parts[2]) || 0;
    const avg = parseFloat(sleepAvg7d) || 0;
    const sleepEmoji = total >= 7.5 ? '✅' : total >= 6 ? '⚠️' : '🔴';
    const delta = avg > 0 ? ` (7d avg ${avg}h)` : '';
    result += `\n  ${sleepEmoji} Sleep: ${total.toFixed(1)}h${delta} — deep ${deep.toFixed(1)}h, REM ${rem.toFixed(1)}h`;
  }

  if (hrv7d) {
    const h7 = parseInt(hrv7d) || 0;
    const h30 = parseInt(hrv30d) || h7;
    const trend = h7 > h30 * 1.05 ? '↑' : h7 < h30 * 0.95 ? '↓' : '→';
    result += `\n  HRV: ${h7} ms ${trend} (30d: ${h30}) · RHR: ${rhr || '?'} bpm`;
  } else if (rhr) {
    result += `\n  RHR: ${rhr} bpm`;
  }

  if (steps) {
    const s = parseInt(steps) || 0;
    const avg = parseInt(stepsAvg7d) || 0;
    const delta = avg > 0 ? ` (7d avg ${avg.toLocaleString()})` : '';
    result += `\n  Steps: ${s.toLocaleString()}${delta}`;
  }

  if (interventions) {
    const items = interventions.split('\n').filter(Boolean);
    if (items.length > 0) {
      result += `\n  💊 ${items.join(', ')}`;
    }
  }

  return result;
}

/** Fetch the LLM-generated health narrative (cached, regenerates daily) */
async function fetchHealthNarrative(): Promise<string> {
  try {
    const resp = await fetch('https://fitness.tools.ejfox.com/api/narrative', {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return '';
    const data: any = await resp.json();
    const narrative = data?.narrative || '';
    if (!narrative || narrative.startsWith('(')) return '';
    // Strip markdown bold markers for Discord, keep it readable
    return narrative.replace(/\*\*/g, '**');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main briefing generator
// ---------------------------------------------------------------------------

async function generateBriefing(_config: BriefingConfig): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const parts: string[] = [];
  parts.push(`**Morning Brief — ${dateStr}**`);

  // Weather + location (async — needs fetch)
  const weather = await generateWeatherSection();
  if (weather) parts.push(weather);

  // Health (sleep, HRV, steps, interventions)
  const health = generateHealthSection();
  if (health) parts.push(health);

  // Health narrative (LLM-generated daily report) — just the first paragraph
  const narrative = await fetchHealthNarrative();
  if (narrative) {
    // Grab first meaningful paragraph (skip the **Yesterday** header)
    const paragraphs = narrative.split('\n\n').filter(p => p.length > 30 && !p.startsWith('**'));
    const first = paragraphs[0] || '';
    if (first.length > 30) {
      const trimmed = first.length > 300 ? first.substring(0, 297) + '...' : first;
      parts.push(`📝 ${trimmed}\n→ [full health report](https://fitness.tools.ejfox.com/insights)`);
    }
  }

  // Calendar (async — needs fetch)
  const calendar = await generateCalendarSection();
  if (calendar) parts.push(calendar);

  // Mail (async — needs fetch)
  const mail = await generateMailSection();
  if (mail) parts.push(mail);

  // Tasks
  const tasks = generateTasksSection();
  if (tasks) parts.push(tasks);

  // OSINT signals block
  const osintSections = [
    await generateSkywatchSection(),
    generateCountySection(),
    generateContractSection(),
    generateDonorSection(),
    generateAnomalySection(),
  ].filter(Boolean);

  if (osintSections.length > 0) {
    parts.push(osintSections.join('\n'));
  }

  // Latest briefing link
  const briefingLink = generateBriefingLink();
  if (briefingLink) parts.push(briefingLink);

  // Footer — compact links
  parts.push('─── [sky](https://skywatch.tools.ejfox.com) · [kanban](https://kanban.tools.ejfox.com) · [health](https://fitness.tools.ejfox.com/insights) · [intel](https://intel.tools.ejfox.com) · [briefings](https://briefings.tools.ejfox.com)');

  let result = parts.join('\n\n');

  // Discord has a 2000 char limit — trim from the middle (OSINT sections) if needed
  if (result.length > 1950) {
    // Drop the least critical sections until we fit
    const dropOrder = ['briefingLink', 'mail'];
    for (const key of dropOrder) {
      if (result.length <= 1950) break;
      const idx = parts.findIndex(p => {
        if (key === 'briefingLink') return p.startsWith('📄');
        if (key === 'mail') return p.startsWith('📧');
        return false;
      });
      if (idx >= 0) parts.splice(idx, 1);
    }
    result = parts.join('\n\n');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Capability handler
// ---------------------------------------------------------------------------

async function handleMorningBriefing(
  params: MorningBriefingParams,
  _content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'ej';

  logger.info(`Morning briefing - Action: ${action}, UserId: ${userId}`);

  try {
    switch (action) {
      case 'setup':
      case 'configure':
      case 'set': {
        const time = params.time || '8am';
        const timezone = params.timezone || 'America/New_York';
        const channel = params.channel || 'discord';
        const cronTime = parseTimeToCron(time, timezone);

        const config: BriefingConfig = {
          userId,
          enabled: true,
          cronTime,
          timezone,
          deliveryChannel: channel,
        };

        briefingConfigs.set(userId, config);

        const taskId = `owner-morning-briefing`;
        await schedulerService.scheduleTask({
          id: taskId,
          name: 'morning-briefing',
          cron: cronTime,
          data: { type: 'morning-briefing', userId, channel },
          options: { timezone },
        });

        return `**Morning briefing configured!**\n\n**Time**: ${time} (${timezone})\n**Delivery**: ${channel}\n**Content**: Weather, OSINT signals, tasks, latest briefing\n\nSay "show briefing now" to preview.`;
      }

      case 'show':
      case 'preview':
      case 'now': {
        let config = briefingConfigs.get(userId);
        if (!config) {
          config = {
            userId,
            enabled: true,
            cronTime: '0 8 * * *',
            timezone: 'America/New_York',
            deliveryChannel: 'discord',
          };
        }
        return await generateBriefing(config);
      }

      case 'status':
      case 'config': {
        const config = briefingConfigs.get(userId);
        if (!config) {
          return `**Morning Briefing**: Not configured yet.\n\nSet it up with: "set up morning briefing at 8am"`;
        }

        return `**Morning Briefing Status**\n\n**Enabled**: ${config.enabled ? 'Yes' : 'No'}\n**Time**: ${config.cronTime} (${config.timezone})\n**Delivery**: ${config.deliveryChannel}\n**Last Delivered**: ${config.lastDelivered || 'Never'}`;
      }

      case 'enable': {
        const config = briefingConfigs.get(userId);
        if (!config) return `No briefing configured. Use "set up morning briefing at 8am" first.`;
        config.enabled = true;
        return `Morning briefing enabled.`;
      }

      case 'disable':
      case 'pause': {
        const config = briefingConfigs.get(userId);
        if (!config) return `No briefing configured.`;
        config.enabled = false;
        return `Morning briefing paused. Say "enable briefing" to resume.`;
      }

      default:
        return `Unknown briefing action: ${action}. Try: setup, show, status, enable, disable`;
    }
  } catch (error) {
    logger.error('Morning briefing error:', error);
    return `Briefing error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const morningBriefingCapability: RegisteredCapability = {
  name: 'morning-briefing',
  emoji: '☀️',
  supportedActions: ['setup', 'configure', 'set', 'show', 'preview', 'now', 'status', 'config', 'enable', 'disable', 'pause'],
  description: `Daily intelligence briefing with real OSINT data. Actions:
- setup/configure: Set up daily briefing (time, timezone, delivery channel)
- show/preview/now: Generate and show briefing immediately
- status/config: View current briefing configuration
- enable/disable: Turn briefing on or off

Example: "set up morning briefing at 8am" or "show my briefing now"`,
  handler: handleMorningBriefing,
};

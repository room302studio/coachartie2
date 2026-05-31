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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { basename, dirname } from 'path';

// OSINT database paths
const DB_PATHS = {
  skywatch: '/opt/docker/smallweb/data/skywatch/data/skywatch.db',
  countywatch: '/opt/docker/smallweb/data/countywatch/data/countywatch.db',
  contractwatch: '/opt/docker/smallweb/data/contractwatch/data/contractwatch.db',
  donorwatch: '/opt/docker/smallweb/data/donorwatch/data/donorwatch.db',
  anomalywatch: '/opt/docker/smallweb/data/anomalywatch/data/anomalywatch.db',
  riverwatch: '/opt/docker/smallweb/data/riverwatch/data/riverwatch.db',
  health: '/opt/docker/smallweb/data/health-webhook/data/health.db',
  entityhub: '/opt/docker/smallweb/data/entityhub/data/entityhub.db',
  masintwatch: '/opt/docker/smallweb/data/masintwatch/data/masintwatch.db',
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
// Day-over-day dedup — suppress sections that haven't changed
// ---------------------------------------------------------------------------

const BRIEFING_CACHE_PATH = '/tmp/morning-briefing-last-sections.json';

interface BriefingCache {
  date: string;
  silentInvestigations: string[];
  tensionItems: string[];
}

function loadBriefingCache(): BriefingCache | null {
  try {
    if (!existsSync(BRIEFING_CACHE_PATH)) return null;
    const data = JSON.parse(readFileSync(BRIEFING_CACHE_PATH, 'utf-8'));
    // Only use cache from yesterday or today (not stale multi-day cache)
    const cacheDate = new Date(data.date);
    const ageDays = (Date.now() - cacheDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 2) return null;
    return data as BriefingCache;
  } catch {
    return null;
  }
}

function saveBriefingCache(cache: BriefingCache): void {
  try {
    const dir = dirname(BRIEFING_CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BRIEFING_CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Non-critical, ignore
  }
}

/**
 * Filter out tension items that are identical to yesterday's.
 * If "No signals 48h: Chester ICE" appeared yesterday too, suppress it.
 */
function filterRepeatedTensionItems(items: string[], cache: BriefingCache | null): string[] {
  if (!cache) return items;
  const yesterdaySet = new Set(cache.tensionItems.map(t => t.toLowerCase().trim()));
  return items.filter(item => {
    // Only filter "No signals" repeats — new tensions should always show
    if (!item.startsWith('No signals')) return true;
    return !yesterdaySet.has(item.toLowerCase().trim());
  });
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
  // Filter out EPIC callsigns — these are West Point (USMA) routine training flights
  const notableList = queryDb(DB_PATHS.skywatch,
    `SELECT callsign || ' — ' || REPLACE(details, '; ', ' | ') FROM notable
     WHERE date(spotted_at) >= date('now', '-1 day')
     AND reason NOT LIKE '%low_altitude_military_zone%'
     AND reason NOT LIKE '%new_aircraft%' OR reason NOT LIKE '%new_aircraft'
     AND callsign NOT LIKE '0%'
     AND callsign NOT LIKE 'EPIC%'
     GROUP BY callsign ORDER BY
       CASE WHEN reason LIKE '%watchlist%' THEN 0
            WHEN reason LIKE '%military%' THEN 1
            WHEN reason LIKE '%foreign%' THEN 1
            WHEN reason LIKE '%emergency%' THEN 0
            WHEN reason LIKE '%plane_alert_db%' THEN 2
            ELSE 3 END,
       MAX(spotted_at) DESC
     LIMIT 5`);

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

// KNOWN ISSUE: countywatch is healthy overall but Chester-specific topic monitoring
// is broken — Chester ICE/detention signals are not being ingested properly.
// The county feed works fine for general news but the Chester topic filter
// needs investigation. See audit notes for details.
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
     LIMIT 3`);

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
     AND timestamp > datetime('now', '-3 days')
     AND title NOT LIKE '%TEST%'
     AND title NOT LIKE '%OSINT Health%'
     AND title NOT LIKE '%Health Check%'
     AND source NOT LIKE 'osint-health%'
     AND source != 'overwatch'
     AND source != 'polymarket'
     AND source != 'egoscan'
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
    const suggestedAll = cards.filter((c: any) => c.lane === 'Suggested');
    const suggested = suggestedAll.slice(0, 3);

    if (active.length === 0 && blocked.length === 0 && suggested.length === 0) return '';

    let text = '📋 **Tasks**';
    for (const c of active) text += `\n  → ${c.title}`;
    for (const c of blocked) {
      const reason = (c.blocked_reason || c.blockedReason || '').substring(0, 60);
      text += `\n  ⛔ ${c.title}${reason ? ' — ' + reason : ''}`;
    }
    if (readyCount > 0) text += `\n  (${readyCount} ready)`;
    if (suggested.length > 0) {
      const extra = suggestedAll.length > 3 ? ` (+${suggestedAll.length - 3} more)` : '';
      text += `\n  💡 Review${extra}: ${suggested.map((c: any) => c.title.substring(0, 35)).join(' · ')}`;
      text += `\n  → [kanban](https://kanban.tools.ejfox.com)`;
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
  // Staleness check: skip if health DB hasn't received data recently
  const lastHealthData = queryDb(DB_PATHS.health,
    `SELECT ROUND(julianday('now') - julianday(MAX(date))) FROM metrics`);
  const healthStaleDays = parseInt(lastHealthData) || 999;
  if (healthStaleDays > 7) {
    logger.info(`Health DB stale (${healthStaleDays}d since last data), skipping health section`);
    return '';
  }

  // Last night's sleep (full breakdown)
  const sleep = queryDb(DB_PATHS.health,
    `SELECT json_extract(raw, '$.totalSleep') as total,
            json_extract(raw, '$.deep') as deep,
            json_extract(raw, '$.rem') as rem,
            json_extract(raw, '$.core') as core
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

  // Breathing disturbances (sleep quality signal — elevated = fragmented sleep)
  const breathingDist = queryDb(DB_PATHS.health,
    `SELECT ROUND(qty, 1) FROM metrics
     WHERE name='breathing_disturbances' ORDER BY date DESC LIMIT 1`);
  const breathingAvg = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(qty), 1) FROM metrics
     WHERE name='breathing_disturbances' AND date >= date('now', '-14 days')`);

  // Wrist temperature (deviation from baseline = illness/stress signal)
  const wristTemp = queryDb(DB_PATHS.health,
    `SELECT ROUND(qty, 1) FROM metrics
     WHERE name='apple_sleeping_wrist_temperature' ORDER BY date DESC LIMIT 1`);
  const wristTempAvg = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(qty), 1) FROM metrics
     WHERE name='apple_sleeping_wrist_temperature' AND date >= date('now', '-14 days')`);

  // Blood oxygen overnight
  const spo2 = queryDb(DB_PATHS.health,
    `SELECT ROUND(AVG(qty),1) || '|' || ROUND(MIN(qty),1) FROM metrics
     WHERE name='blood_oxygen_saturation'
       AND date = (SELECT MAX(date) FROM metrics WHERE name='blood_oxygen_saturation')`);

  // Time in daylight yesterday (circadian health)
  const daylight = queryDb(DB_PATHS.health,
    `SELECT ROUND(SUM(qty)) FROM metrics
     WHERE name='time_in_daylight'
       AND date(date) = (SELECT MAX(date(date)) FROM metrics WHERE name='time_in_daylight' AND date(date) < date('now'))`);

  // Yesterday's interventions
  const interventions = queryDb(DB_PATHS.health,
    `SELECT substance || COALESCE(' ' || CAST(CAST(dose AS INT) AS TEXT) || unit, '')
     FROM interventions
     WHERE date(timestamp) = date('now', '-1 day')
     ORDER BY timestamp`);

  if (!sleep && !hrv7d && !steps) return '';

  let result = '🏥 **Health**';

  // --- Body readiness composite ---
  const sleepTotal = sleep ? parseFloat(sleep.split('|')[0]) || 0 : 0;
  const h7 = parseInt(hrv7d) || 0;
  const h30 = parseInt(hrv30d) || h7;
  const rhrVal = parseInt(rhr) || 0;
  const bd = parseFloat(breathingDist) || 0;
  const bdAvg = parseFloat(breathingAvg) || bd;

  // Score: 0-100 composite — sleep quality + HRV trend + breathing
  let readiness = 50; // baseline
  if (sleepTotal >= 7.5) readiness += 20;
  else if (sleepTotal >= 6.5) readiness += 10;
  else if (sleepTotal < 5) readiness -= 20;
  else if (sleepTotal < 6) readiness -= 10;
  if (h7 > 0 && h30 > 0) {
    if (h7 > h30 * 1.1) readiness += 15;
    else if (h7 > h30 * 1.03) readiness += 5;
    else if (h7 < h30 * 0.85) readiness -= 15;
    else if (h7 < h30 * 0.95) readiness -= 5;
  }
  if (bd > 0 && bdAvg > 0) {
    if (bd > bdAvg * 1.5) readiness -= 10; // fragmented sleep
    else if (bd < bdAvg * 0.7) readiness += 5; // unusually clean sleep
  }
  readiness = Math.max(0, Math.min(100, readiness));

  const readinessEmoji = readiness >= 75 ? '🟢' : readiness >= 50 ? '🟡' : '🔴';
  result += `\n  ${readinessEmoji} Body readiness: ${readiness}/100`;

  if (sleep) {
    const parts = sleep.split('|');
    const total = parseFloat(parts[0]) || 0;
    const deep = parseFloat(parts[1]) || 0;
    const rem = parseFloat(parts[2]) || 0;
    const avg = parseFloat(sleepAvg7d) || 0;
    const sleepEmoji = total >= 7.5 ? '✅' : total >= 6 ? '⚠️' : '🔴';
    const delta = avg > 0 ? ` (7d avg ${avg}h)` : '';
    let sleepLine = `${sleepEmoji} Sleep: ${total.toFixed(1)}h${delta} — deep ${deep.toFixed(1)}h, REM ${rem.toFixed(1)}h`;
    // Flag fragmented sleep
    if (bd > 0 && bdAvg > 0 && bd > bdAvg * 1.5) {
      sleepLine += ` ⚠️ breathing disturbances elevated (${bd} vs avg ${bdAvg})`;
    }
    result += `\n  ${sleepLine}`;
  }

  if (hrv7d) {
    const trend = h7 > h30 * 1.05 ? '↑' : h7 < h30 * 0.95 ? '↓' : '→';
    result += `\n  HRV: ${h7}ms ${trend} (30d: ${h30}) · RHR: ${rhr || '?'}bpm`;
  } else if (rhr) {
    result += `\n  RHR: ${rhr}bpm`;
  }

  // Wrist temp deviation (illness early warning)
  if (wristTemp && wristTempAvg) {
    const temp = parseFloat(wristTemp);
    const avg = parseFloat(wristTempAvg);
    const delta = temp - avg;
    if (Math.abs(delta) > 0.5) {
      const dir = delta > 0 ? '↑' : '↓';
      result += `\n  🌡️ Wrist temp ${dir}${Math.abs(delta).toFixed(1)}°F from baseline — ${delta > 0.8 ? 'possible illness onset' : 'notable deviation'}`;
    }
  }

  // Blood oxygen (flag if low)
  if (spo2) {
    const [avgO2, minO2] = spo2.split('|').map(Number);
    if (minO2 < 94) {
      result += `\n  🫁 SpO2 dipped to ${minO2}% overnight (avg ${avgO2}%)`;
    }
  }

  if (steps) {
    const s = parseInt(steps) || 0;
    const avg = parseInt(stepsAvg7d) || 0;
    const delta = avg > 0 ? ` (7d avg ${avg.toLocaleString()})` : '';
    result += `\n  Steps: ${s.toLocaleString()}${delta}`;
  }

  // Daylight exposure
  if (daylight) {
    const mins = parseInt(daylight) || 0;
    if (mins > 0) {
      const daylightNote = mins < 30 ? ' — low, get outside today' : mins > 120 ? ' — solid outdoor time' : '';
      result += `\n  ☀️ ${mins}min daylight yesterday${daylightNote}`;
    }
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

function generateTensionSection(): string {
  const tensions: string[] = [];

  // PRIMARY sources — exclude aggregators (artie-digest, daily-briefing, claude)
  // NOTE: overwatch REMOVED — it fabricates military flight data that contradicts skywatch
  const primaryList = "'skywatch','countywatch','contractwatch','donorwatch','filingwatch','changewatch','masintwatch','redditwatch','riverwatch','honeypot','egoscan'";

  // 1. VOLUME DIVERGENCE: Yesterday's military flights vs 14-day average
  //    Use yesterday (complete day) to avoid partial-day false positives
  //    Requires >30% deviation to trigger — shorter baselines and lower thresholds
  //    produced too many false positives from normal day-to-day variance
  const milYesterday = queryDb(DB_PATHS.skywatch,
    "SELECT COALESCE(military_flights, 0) FROM daily_stats WHERE date = date('now', '-1 day')");
  const milAvg = queryDb(DB_PATHS.skywatch,
    "SELECT ROUND(AVG(military_flights), 0) FROM daily_stats WHERE date >= date('now', '-15 days') AND date < date('now', '-1 day')");
  const mt = parseInt(milYesterday) || 0;
  const ma = parseInt(milAvg) || 0;
  if (ma > 5 && Math.abs(mt - ma) / ma >= 0.3) {
    const dir = mt > ma ? '↑' : '↓';
    const pct = Math.round(Math.abs(mt - ma) / ma * 100);
    tensions.push(`Military flights yesterday: ${mt} vs ${ma} avg/14d (${dir}${pct}%)`);
  }

  // Total flight volume divergence (yesterday vs 14-day avg, >30% threshold)
  const flightsYesterday = queryDb(DB_PATHS.skywatch,
    "SELECT COALESCE(total_flights, 0) FROM daily_stats WHERE date = date('now', '-1 day')");
  const flightsAvg = queryDb(DB_PATHS.skywatch,
    "SELECT ROUND(AVG(total_flights), 0) FROM daily_stats WHERE date >= date('now', '-15 days') AND date < date('now', '-1 day')");
  const ft = parseInt(flightsYesterday) || 0;
  const fa = parseInt(flightsAvg) || 0;
  if (fa > 100 && Math.abs(ft - fa) / fa >= 0.3) {
    const dir = ft > fa ? '↑' : '↓';
    const pct = Math.round(Math.abs(ft - fa) / fa * 100);
    tensions.push(`Total flights yesterday: ${ft} vs ${fa} avg/14d (${dir}${pct}%)`);
  }

  // 2. SINGLE-SOURCE HIGH SIGNALS: Score ≥6 signals from only one primary source
  //    Find signals where no other primary source reported on the same investigation
  //    Exclude noise sources: polymarket (prediction markets), egoscan (vanity),
  //    rescuetime (productivity tracking) — these never corroborate real OSINT
  const singleSource = queryDb(DB_PATHS.anomalywatch,
    `SELECT s.source, SUBSTR(s.title, 1, 70), ROUND(s.final_score, 1)
     FROM signals s
     WHERE s.final_score >= 6
       AND s.ingested_at >= datetime('now', '-48 hours')
       AND s.source IN (${primaryList})
       AND s.source NOT IN ('polymarket', 'egoscan', 'rescuetime')
       AND s.id NOT IN (
         SELECT isig.signal_id FROM investigation_signals isig
         JOIN investigation_signals isig2 ON isig.investigation_id = isig2.investigation_id
         JOIN signals s2 ON isig2.signal_id = s2.id
         WHERE s2.source != s.source AND s2.source IN (${primaryList})
           AND s2.ingested_at >= datetime('now', '-48 hours')
       )
     ORDER BY s.final_score DESC
     LIMIT 2`);

  if (singleSource) {
    for (const line of singleSource.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        tensions.push(`Single-source: ${parts[0]}: ${parts[1]} [${parts[2]}]`);
      }
    }
  }

  // 3. CROSS-SOURCE ENTITY TENSION: Same entity in 2+ DIFFERENT source types
  // (countywatch+changewatch are same type — local gov; skywatch is primary for aviation)
  // Only flag when entity bridges source families
  const entityTension = queryDb(DB_PATHS.entityhub,
    `SELECT sub.name, GROUP_CONCAT(sub.app, ', ') FROM (
       SELECT DISTINCT e.canonical_name as name, em.app_name as app, e.id
       FROM entities e
       JOIN entity_mentions em ON e.id = em.entity_id
       WHERE em.timestamp >= datetime('now', '-48 hours')
         AND em.app_name IN (${primaryList})
         AND LENGTH(e.canonical_name) > 5
         AND e.canonical_name NOT LIKE '%Committee%'
         AND e.canonical_name NOT LIKE '%Order %'
         AND e.canonical_name NOT LIKE '%County%'
         AND e.canonical_name NOT LIKE '%Board%'
         AND e.entity_type IN ('person', 'organization', 'facility', 'government_agency')
     ) sub
     GROUP BY sub.id
     HAVING COUNT(sub.app) >= 2
     ORDER BY COUNT(sub.app) DESC
     LIMIT 2`);

  if (entityTension) {
    for (const line of entityTension.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length >= 2) {
        tensions.push(`Multi-source: ${parts[0]} (${parts[1]})`);
      }
    }
  }

  // 4. EXPECTED SILENCE: Active investigations with no recent signals
  const silentInvestigations = queryDb(DB_PATHS.anomalywatch,
    `SELECT i.title
     FROM investigations i
     WHERE i.status = 'active'
       AND i.id NOT IN (
         SELECT isig.investigation_id FROM investigation_signals isig
         JOIN signals s ON isig.signal_id = s.id
         WHERE s.ingested_at >= datetime('now', '-48 hours')
           AND s.source IN (${primaryList})
       )
     LIMIT 2`);

  if (silentInvestigations) {
    for (const line of silentInvestigations.split('\n').filter(Boolean)) {
      tensions.push(`No signals 48h: ${line}`);
    }
  }

  // 5. INVESTIGATION VELOCITY CHANGE: Compare last-24h signal count per investigation
  //    vs its 7-day daily average. Flag accelerating (>2x) or decelerating (<0.25x)
  //    investigations — sudden changes in signal flow indicate something happening
  //    or a source going quiet on a topic
  const velocityData = queryDb(DB_PATHS.anomalywatch,
    `SELECT i.title,
            COALESCE(recent.cnt, 0) as last_24h,
            COALESCE(baseline.daily_avg, 0) as avg_7d
     FROM investigations i
     LEFT JOIN (
       SELECT isig.investigation_id, COUNT(*) as cnt
       FROM investigation_signals isig
       JOIN signals s ON isig.signal_id = s.id
       WHERE s.ingested_at >= datetime('now', '-24 hours')
       GROUP BY isig.investigation_id
     ) recent ON i.id = recent.investigation_id
     LEFT JOIN (
       SELECT isig.investigation_id, ROUND(COUNT(*) / 7.0, 1) as daily_avg
       FROM investigation_signals isig
       JOIN signals s ON isig.signal_id = s.id
       WHERE s.ingested_at >= datetime('now', '-7 days')
         AND s.ingested_at < datetime('now', '-24 hours')
       GROUP BY isig.investigation_id
     ) baseline ON i.id = baseline.investigation_id
     WHERE i.status = 'active'
       AND baseline.daily_avg >= 1
     ORDER BY i.title`);

  if (velocityData) {
    for (const line of velocityData.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const invTitle = parts[0].trim();
      const last24h = parseFloat(parts[1]) || 0;
      const avg7d = parseFloat(parts[2]) || 0;
      if (avg7d <= 0) continue;
      const ratio = last24h / avg7d;
      if (ratio > 2) {
        tensions.push(`Accelerating: ${invTitle} — ${last24h} signals/24h vs ${avg7d} avg/day (${ratio.toFixed(1)}x)`);
      } else if (ratio < 0.25 && last24h < avg7d) {
        tensions.push(`Decelerating: ${invTitle} — ${last24h} signals/24h vs ${avg7d} avg/day (${ratio.toFixed(1)}x)`);
      }
    }
  }

  // Day-over-day dedup: suppress "No signals" items that appeared yesterday too
  const cache = loadBriefingCache();
  const filtered = filterRepeatedTensionItems(tensions, cache);

  if (filtered.length === 0) return '';
  return '🔀 **Tension**\n' + filtered.map(t => `  · ${t}`).join('\n');
}

function generateConfidenceMesh(): string {
  // All primary watchers (exclude aggregators like artie-digest, daily-briefing, claude)
  // NOTE: overwatch REMOVED — it fabricates military flight data that contradicts skywatch
  const primarySources = [
    'skywatch', 'countywatch', 'contractwatch', 'donorwatch',
    'filingwatch', 'changewatch', 'masintwatch',
    'redditwatch', 'riverwatch', 'egoscan',
  ];

  const meshLines: string[] = [];

  // --- Part 1: Per-investigation source coverage ---
  // For each active investigation, show which primary sources contributed recently vs silent
  // Use subquery to dedupe sources — GROUP_CONCAT(DISTINCT x) not supported in all sqlite builds
  const invData = queryDb(DB_PATHS.anomalywatch,
    `SELECT sub.id, sub.title, GROUP_CONCAT(sub.source) FROM (
       SELECT DISTINCT i.id, i.title, s.source
       FROM investigations i
       JOIN investigation_signals isig ON i.id = isig.investigation_id
       JOIN signals s ON isig.signal_id = s.id
       WHERE i.status = 'active'
         AND s.ingested_at >= datetime('now', '-7 days')
         AND s.source IN (${primarySources.map(s => `'${s}'`).join(',')})
     ) sub
     GROUP BY sub.id
     ORDER BY COUNT(*) DESC`);

  if (invData) {
    for (const line of invData.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const invTitle = parts[1];
      const activeSources = parts[2].split(',').filter(Boolean);
      // Only show sources that COULD be relevant (have ever contributed to any investigation)
      // Silent = primary source that hasn't reported on this investigation in 7 days
      const silent = primarySources.filter(s =>
        !activeSources.includes(s) &&
        // Only flag silence from sources likely to have relevant data
        // (skip masintwatch/riverwatch/egoscan for contract investigations, etc.)
        isSourceRelevant(s, invTitle)
      );

      // Abbreviate investigation title for compactness
      const shortTitle = invTitle.replace(/ Regional Activity| Detention Complex/g, '').substring(0, 25);
      const activeStr = activeSources.map(s => shortenSource(s)).join(', ');
      let entry = `${shortTitle}: ${activeStr}`;
      if (silent.length > 0 && silent.length <= 4) {
        entry += ` · silent: ${silent.map(s => shortenSource(s)).join(', ')}`;
      }
      meshLines.push(entry);
    }
  }

  // --- Part 2: Top unlinked signals (high score, not in any investigation) ---
  const orphanSignals = queryDb(DB_PATHS.anomalywatch,
    `SELECT s.source, SUBSTR(s.title, 1, 45), ROUND(s.final_score, 1)
     FROM signals s
     WHERE s.final_score >= 5
       AND s.ingested_at >= datetime('now', '-48 hours')
       AND s.source IN (${primarySources.map(s => `'${s}'`).join(',')})
       AND s.id NOT IN (SELECT signal_id FROM investigation_signals)
       AND s.title NOT LIKE '%TEST%'
       AND s.title NOT LIKE '%OSINT Health%'
     ORDER BY s.final_score DESC
     LIMIT 2`);

  if (orphanSignals) {
    for (const line of orphanSignals.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      meshLines.push(`⚠ ${parts[1].trim()} [${shortenSource(parts[0])} only, ${parts[2]}]`);
    }
  }

  // --- Part 3: New entities — first seen in last 48h with 2+ mentions ---
  // New entities appearing across sources is high signal — something new entered
  // the information environment
  const newEntities = queryDb(DB_PATHS.entityhub,
    `SELECT e.canonical_name, e.entity_type, COUNT(em.id) as mention_count,
            GROUP_CONCAT(DISTINCT em.app_name) as sources
     FROM entities e
     JOIN entity_mentions em ON e.id = em.entity_id
     WHERE e.first_seen >= datetime('now', '-48 hours')
       AND LENGTH(e.canonical_name) > 5
       AND e.canonical_name NOT LIKE '%Committee%'
       AND e.canonical_name NOT LIKE '%Order %'
       AND e.canonical_name NOT LIKE '%County%'
       AND e.canonical_name NOT LIKE '%Board%'
       AND e.entity_type IN ('person', 'organization', 'facility', 'government_agency')
     GROUP BY e.id
     HAVING COUNT(em.id) >= 2
     ORDER BY COUNT(em.id) DESC
     LIMIT 3`);

  if (newEntities) {
    for (const line of newEntities.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const name = parts[0].trim();
      const type = parts[1].trim();
      const mentions = parts[2].trim();
      const sources = parts[3].trim();
      meshLines.push(`New ${type}: ${name} (${mentions} mentions — ${sources})`);
    }
  }

  // --- Part 4: Source liveness summary ---
  // Which primary sources have reported in the last 24h vs gone dark
  const activeLast24h = queryDb(DB_PATHS.anomalywatch,
    `SELECT DISTINCT source FROM signals
     WHERE ingested_at >= datetime('now', '-24 hours')
       AND source IN (${primarySources.map(s => `'${s}'`).join(',')})`);

  const activeSet = new Set(activeLast24h ? activeLast24h.split('\n').filter(Boolean) : []);
  const darkSources = primarySources.filter(s =>
    !activeSet.has(s) && !['honeypot', 'masintwatch'].includes(s) // these are low-volume by design
  );

  if (darkSources.length > 0) {
    meshLines.push(`Dark 24h: ${darkSources.map(s => shortenSource(s)).join(', ')}`);
  }

  // --- Part 5: Sources that CAME BACK online ---
  // Detect sources that were dark >48h but have signals in the last 24h.
  // A source coming back online after extended silence is noteworthy — it may
  // have missed events during the outage, or its return signals may be backfill
  const cameBackSources: string[] = [];
  for (const src of primarySources) {
    if (!activeSet.has(src)) continue; // not active now, skip
    if (['honeypot', 'masintwatch'].includes(src)) continue; // low-volume by design

    // Check if this source had NO signals in the 24h-to-72h window (was dark >48h)
    const priorActivity = queryDb(DB_PATHS.anomalywatch,
      `SELECT COUNT(*) FROM signals
       WHERE source = '${src}'
         AND ingested_at >= datetime('now', '-72 hours')
         AND ingested_at < datetime('now', '-24 hours')`);
    const priorCount = parseInt(priorActivity) || 0;
    if (priorCount === 0) {
      cameBackSources.push(shortenSource(src));
    }
  }

  if (cameBackSources.length > 0) {
    meshLines.push(`Came back online: ${cameBackSources.join(', ')} (was dark >48h)`);
  }

  if (meshLines.length === 0) return '';
  return '🔍 **Confidence**\n' + meshLines.map(l => `  · ${l}`).join('\n');
}

/** Shorten source names for compact display */
function shortenSource(source: string): string {
  const map: Record<string, string> = {
    skywatch: 'sky', countywatch: 'county', contractwatch: 'contracts',
    donorwatch: 'donors', filingwatch: 'filings', changewatch: 'changes',
    masintwatch: 'masint', redditwatch: 'reddit',
    riverwatch: 'river', egoscan: 'ego', honeypot: 'honeypot',
  };
  return map[source] || source;
}

/** Heuristic: is a given source relevant to an investigation? */
function isSourceRelevant(source: string, invTitle: string): boolean {
  const lower = invTitle.toLowerCase();
  // Map sources to the investigation topics they'd plausibly cover
  const relevanceMap: Record<string, string[]> = {
    skywatch: ['flight', 'aircraft', 'military', 'ang', 'stewart', 'ice', 'corridor'],
    countywatch: ['ice', 'detention', 'county', 'contract', 'hudson', 'chester'],
    contractwatch: ['contract', 'federal', 'ice', 'dhs', 'detention'],
    donorwatch: ['election', 'donor', 'campaign', 'political'],
    filingwatch: ['sec', 'filing', 'corporate', 'contract', 'federal'],
    changewatch: ['website', 'policy', 'ice', 'detention', 'county'],
    // overwatch removed — fabricates data
    redditwatch: ['stewart', 'military', 'ice', 'hudson', 'flight', 'detention'],
    // These are rarely relevant to specific investigations
    masintwatch: [],
    riverwatch: ['river', 'vessel', 'waterway', 'ferry'],
    egoscan: [],
  };
  const keywords = relevanceMap[source] || [];
  return keywords.some(k => lower.includes(k));
}

// ---------------------------------------------------------------------------
// Main briefing generator
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// New data sections: MASINT + River
// ---------------------------------------------------------------------------

function generateRecentTrips(): string {
  try {
    // Check for ride logs from last 24h
    const logDir = '/data2/owntracks/ride-logs';
    if (!existsSync(logDir)) return '';
    const files = readdirSync(logDir).filter(f => f.endsWith('.json')).sort().reverse();
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().split('T')[0];
    const recentFiles = files.filter(f => f >= yesterday);
    if (recentFiles.length === 0) return '';

    const trips: string[] = [];
    for (const f of recentFiles.slice(0, 3)) {
      try {
        const log = JSON.parse(readFileSync(`${logDir}/${f}`, 'utf-8'));
        const icon = log.motorcycle ? '🏍️' : '🗺️';
        const hrs = Math.floor(log.durationMinutes / 60);
        const mins = log.durationMinutes % 60;
        const dur = hrs > 0 ? `${hrs}h${mins > 0 ? mins + 'm' : ''}` : `${mins}m`;
        const counties = (log.countiesTraversed || []).join(' → ');
        const elev = log.elevationGainFt > 100 ? ` ↑${log.elevationGainFt}ft` : '';
        const pois = (log.nearbyPois || []).length > 0 ? ` · near ${log.nearbyPois.join(', ')}` : '';
        trips.push(`${icon} ${dur}, ${log.distanceMiles}mi — ${counties}${elev}${pois}`);
      } catch { /* skip bad files */ }
    }

    if (trips.length === 0) return '';
    return `Recent trips:\n${trips.map(t => `  · ${t}`).join('\n')}`;
  } catch { return ''; }
}

function generateCrossDomainInsights(
  sections: Record<string, string>,
  town: string, county: string, inHV: boolean,
  lat: number, lon: number
): string {
  const insights: string[] = [];

  try {
    // --- HEALTH × CALENDAR: readiness vs workload ---
    const healthRaw = sections['health'] || '';
    const calendarRaw = sections['calendar'] || '';
    const readinessMatch = healthRaw.match(/Body readiness: (\d+)\/100/);
    const readiness = readinessMatch ? parseInt(readinessMatch[1]) : -1;
    const meetingMatch = calendarRaw.match(/\((\d+) today\)/);
    const meetingCount = meetingMatch ? parseInt(meetingMatch[1]) : 0;

    if (readiness >= 0 && meetingCount > 0) {
      if (readiness < 50 && meetingCount >= 3) {
        insights.push(`⚡ CAPACITY WARNING: readiness ${readiness}/100 heading into ${meetingCount} meetings — consider rescheduling non-essential calls`);
      } else if (readiness < 40 && meetingCount >= 1) {
        insights.push(`⚡ LOW READINESS (${readiness}/100) with ${meetingCount} on the calendar — protect your energy today`);
      } else if (readiness >= 80 && meetingCount <= 1) {
        insights.push(`⚡ high readiness (${readiness}/100), light calendar — good day for deep work or investigation`);
      } else if (readiness >= 75 && meetingCount >= 3) {
        insights.push(`⚡ well-rested (${readiness}/100) into a packed day (${meetingCount} events) — good shape for it`);
      }
    }

    // --- HEALTH × TRAVEL: sleep trends since leaving home ---
    const rideState = readJson('/data2/owntracks/ride-state.json');
    if (rideState?.state === 'away' && rideState?.stateStartedAt) {
      const awayDays = Math.floor((Date.now() - new Date(rideState.stateStartedAt).getTime()) / 86400000);
      if (awayDays >= 2) {
        // Compare sleep since departure vs 7d before
        const sleepSinceDeparture = queryDb(DB_PATHS.health,
          `SELECT ROUND(AVG(json_extract(raw, '$.totalSleep')),1) FROM metrics
           WHERE name='sleep_analysis' AND json_extract(raw, '$.totalSleep') >= 2.5
             AND date >= '${rideState.stateStartedAt.slice(0, 10)}'`);
        const sleepBeforeDeparture = queryDb(DB_PATHS.health,
          `SELECT ROUND(AVG(json_extract(raw, '$.totalSleep')),1) FROM metrics
           WHERE name='sleep_analysis' AND json_extract(raw, '$.totalSleep') >= 2.5
             AND date < '${rideState.stateStartedAt.slice(0, 10)}'
             AND date >= date('${rideState.stateStartedAt.slice(0, 10)}', '-7 days')`);
        const since = parseFloat(sleepSinceDeparture) || 0;
        const before = parseFloat(sleepBeforeDeparture) || 0;
        if (since > 0 && before > 0) {
          const diff = since - before;
          if (diff < -0.5) {
            insights.push(`🧳 travel is costing you sleep: ${since}h avg since leaving (day ${awayDays}) vs ${before}h at home — ${Math.abs(diff).toFixed(1)}h deficit/night`);
          } else if (diff > 0.5) {
            insights.push(`🧳 sleeping better on the road: ${since}h avg (day ${awayDays} away) vs ${before}h at home`);
          }
        }
      }
    }

    // --- SLEEP × DAYLIGHT: yesterday's outdoor time → sleep quality ---
    const daylightMatch = healthRaw.match(/(\d+)min daylight yesterday/);
    const sleepMatch = healthRaw.match(/Sleep: ([\d.]+)h/);
    const breathingMatch = healthRaw.match(/breathing disturbances elevated/);
    if (daylightMatch && sleepMatch) {
      const dayMins = parseInt(daylightMatch[1]);
      const sleepHrs = parseFloat(sleepMatch[1]);
      if (dayMins < 20 && sleepHrs < 6.5) {
        insights.push(`🌙 only ${dayMins}min daylight yesterday → ${sleepHrs}h sleep last night. outdoor time before noon helps reset circadian rhythm`);
      } else if (dayMins > 90 && sleepHrs >= 7.5 && !breathingMatch) {
        insights.push(`🌙 ${dayMins}min daylight → ${sleepHrs}h clean sleep. the pattern holds — keep getting outside`);
      }
    }

    // --- HRV × OSINT TEMPO: if you're stressed and signals are hot ---
    const hrvMatch = healthRaw.match(/HRV: (\d+)ms (↑|↓|→) \(30d: (\d+)\)/);
    const anomalyRaw = sections['anomalies'] || '';
    const tensionRaw = sections['tension'] || '';
    if (hrvMatch) {
      const hrv7 = parseInt(hrvMatch[1]);
      const hrv30 = parseInt(hrvMatch[3]);
      const hrvDrop = hrv30 > 0 ? (hrv30 - hrv7) / hrv30 : 0;
      const hasHighSignals = anomalyRaw.includes('score >=') || tensionRaw.includes('multi-source');
      if (hrvDrop > 0.15 && hasHighSignals) {
        insights.push(`📡 HRV down ${Math.round(hrvDrop * 100)}% while signal tempo is elevated — physiological stress aligning with intel activity. stay sharp but manage energy`);
      } else if (hrvDrop > 0.2 && !hasHighSignals) {
        insights.push(`📡 HRV down ${Math.round(hrvDrop * 100)}% but OSINT is quiet — the stress signal is personal, not external`);
      }
    }

    // --- WRIST TEMP × PATTERN: illness early warning ---
    const tempMatch = healthRaw.match(/Wrist temp (↑|↓)([\d.]+)°F from baseline/);
    if (tempMatch) {
      const dir = tempMatch[1];
      const delta = parseFloat(tempMatch[2]);
      if (dir === '↑' && delta > 0.8) {
        const sleepQuality = breathingMatch ? 'with fragmented sleep' : '';
        insights.push(`🌡️ wrist temp elevated ${delta}°F ${sleepQuality} — classic pre-illness pattern. consider clearing tomorrow's calendar preemptively`);
      }
    }

    // --- LOCATION × RIVER/SKY: proximity-based intel ---
    if (inHV) {
      // Check if near the Hudson River (roughly lon -73.9 to -74.0)
      const nearRiver = lon >= -74.05 && lon <= -73.85;
      const riverRaw = sections['riverwatch'] || '';
      if (nearRiver && riverRaw && riverRaw.includes('notable')) {
        insights.push(`🚢 you're near the river and there's vessel activity — ${riverRaw.split('\n')[0]}`);
      }
    }

    // --- ENTITIES × DONORS × NEWS: same names in multiple streams ---
    const donorRaw = sections['donors'] || '';
    const countyRaw = sections['countywatch'] || '';
    const contractRaw = sections['contracts'] || '';
    // Quick entity cross-check: look for names appearing in 2+ sections
    const entityNames = new Map<string, string[]>();
    const extractNames = (text: string, source: string) => {
      // Look for capitalized multi-word names (rough entity extraction)
      const namePattern = /\b([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g;
      let match;
      while ((match = namePattern.exec(text)) !== null) {
        const name = match[1];
        // Skip common false positives
        if (['Hudson Valley', 'Orange County', 'Putnam County', 'New York', 'United States',
             'North America', 'Morning Brief', 'Coach Artie', 'Body readiness'].includes(name)) continue;
        if (!entityNames.has(name)) entityNames.set(name, []);
        const sources = entityNames.get(name)!;
        if (!sources.includes(source)) sources.push(source);
      }
    };
    extractNames(donorRaw, 'donors');
    extractNames(countyRaw, 'news');
    extractNames(contractRaw, 'contracts');

    const crossEntities = [...entityNames.entries()]
      .filter(([, sources]) => sources.length >= 2)
      .map(([name, sources]) => `${name} (${sources.join(' + ')})`);
    if (crossEntities.length > 0) {
      insights.push(`🔗 cross-source entities: ${crossEntities.slice(0, 3).join(', ')} — same names appearing in multiple streams`);
    }

  } catch (err) {
    logger.warn('Cross-domain insights error:', err);
  }

  if (insights.length === 0) return '';
  return `🧠 **Cross-Domain Insights**\n${insights.map(i => `  ${i}`).join('\n')}`;
}

function generateLocationIntel(town: string, county: string, inHV: boolean): string {
  if (!town && !county) return '';
  try {
    const parts: string[] = [];

    // Search countywatch for news mentioning current town/county
    const townClean = town.replace(/^Town of /, '').replace(/^City of /, '');
    const localNews = queryDb(DB_PATHS.countywatch,
      `SELECT title, source FROM news
       WHERE first_seen >= datetime('now', '-48 hours')
         AND (title LIKE '%${townClean}%' OR title LIKE '%${county}%')
       ORDER BY first_seen DESC LIMIT 3`);
    if (localNews) {
      const items = localNews.split('\n').filter(Boolean);
      for (const item of items) {
        parts.push(`· ${item.substring(0, 120)}`);
      }
    }

    // Check anomalywatch for signals mentioning current location
    const localSignals = queryDb(DB_PATHS.anomalywatch,
      `SELECT title FROM signals
       WHERE created_at >= datetime('now', '-48 hours')
         AND (title LIKE '%${townClean}%' OR title LIKE '%${county}%')
         AND final_score >= 2.0
       ORDER BY final_score DESC LIMIT 2`);
    if (localSignals) {
      const items = localSignals.split('\n').filter(Boolean);
      for (const item of items) {
        parts.push(`· ${item.substring(0, 120)}`);
      }
    }

    // If away from HV, check for relevant contract/donor activity in the area
    if (!inHV) {
      const localContracts = queryDb(DB_PATHS.contractwatch,
        `SELECT title FROM contracts
         WHERE first_seen >= datetime('now', '-7 days')
           AND (title LIKE '%${county}%' OR title LIKE '%${townClean}%')
         LIMIT 2`);
      if (localContracts) {
        const items = localContracts.split('\n').filter(Boolean);
        for (const item of items) {
          parts.push(`· ${item.substring(0, 120)}`);
        }
      }
    }

    if (parts.length === 0) return '';
    return `📍 **Near you (${townClean})**\n${parts.join('\n')}`;
  } catch { return ''; }
}

function generateMasintSection(): string {
  const recentEvents = queryDb(DB_PATHS.masintwatch,
    `SELECT source || ': ' || title FROM events
     WHERE first_seen >= datetime('now', '-24 hours')
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, first_seen DESC
     LIMIT 5`);
  if (!recentEvents) return '';

  const count24h = queryDb(DB_PATHS.masintwatch,
    "SELECT COUNT(*) FROM events WHERE first_seen >= datetime('now', '-24 hours')");
  const count7d = queryDb(DB_PATHS.masintwatch,
    "SELECT ROUND(COUNT(*) / 7.0) FROM events WHERE first_seen >= datetime('now', '-7 days')");

  const n = parseInt(count24h) || 0;
  const avg = parseInt(count7d) || 0;
  const delta = avg > 0 ? ` (avg ${avg}/day)` : '';

  let result = `MASINT: ${n} events${delta}`;
  const items = recentEvents.split('\n').filter(Boolean);
  for (const item of items) result += `\n  · ${item.substring(0, 120)}`;
  return result;
}

function generateRiverwatchSection(): string {
  const notableCount = queryDb(DB_PATHS.riverwatch,
    "SELECT COUNT(*) FROM notable_vessels WHERE spotted_at >= datetime('now', '-24 hours')");
  const nc = parseInt(notableCount) || 0;
  if (nc === 0) return '';

  const vessels = queryDb(DB_PATHS.riverwatch,
    `SELECT name || ' (' || flag_reason || ')' FROM notable_vessels
     WHERE spotted_at >= datetime('now', '-24 hours')
     GROUP BY mmsi ORDER BY MAX(spotted_at) DESC LIMIT 3`);

  let result = `River: ${nc} notable vessels`;
  if (vessels) {
    const items = vessels.split('\n').filter(Boolean);
    for (const item of items) result += `\n  · ${item.substring(0, 100)}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Day-over-day deltas for OSINT sections
// ---------------------------------------------------------------------------

function deltaTag(current: number, avgPerDay: number): string {
  if (avgPerDay <= 0) return '';
  const pct = Math.round(((current - avgPerDay) / avgPerDay) * 100);
  if (Math.abs(pct) < 15) return ' →';
  return pct > 0 ? ` ↑${pct}%` : ` ↓${Math.abs(pct)}%`;
}

// ---------------------------------------------------------------------------
// Source health — compact status line for footer
// ---------------------------------------------------------------------------

function generateSourceHealth(): string {
  const sources = [
    { name: 'sky', db: DB_PATHS.skywatch, table: 'flights', col: 'first_seen' },
    { name: 'county', db: DB_PATHS.countywatch, table: 'news', col: 'first_seen' },
    { name: 'contracts', db: DB_PATHS.contractwatch, table: 'contracts', col: 'first_seen' },
    { name: 'donors', db: DB_PATHS.donorwatch, table: 'contributions', col: 'first_seen' },
    { name: 'river', db: DB_PATHS.riverwatch, table: 'notable_vessels', col: 'spotted_at' },
  ];

  const dead: string[] = [];
  for (const s of sources) {
    const last = queryDb(s.db,
      `SELECT ROUND((julianday('now') - julianday(MAX(${s.col}))) * 24) FROM ${s.table}`);
    const hours = parseInt(last) || 0;
    if (hours > 48) {
      dead.push(`${s.name} ${Math.round(hours / 24)}d`);
    }
  }

  if (dead.length === 0) return '';
  return `⚠️ dark: ${dead.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Editor pass — LLM synthesizes raw intel into a tight brief
// ---------------------------------------------------------------------------

const PRIORITY_RUBRIC = `PRIORITY RUBRIC — use this to decide what makes the cut:

LEAD WITH (always include if present):
  · Multi-source corroborations — same entity surfacing in 2+ independent sources
  · Pattern breaks — volume deviations >30%, first-time-seen entities, behavioral shifts
  · High-score orphan signals — score >=5, not linked to any investigation
  · Negative reporting — a normally active source or pattern going unexpectedly silent

INCLUDE (if space permits):
  · Notable single-source signals with score >= 4
  · Volume anomalies exceeding 30% deviation from baseline
  · New entity appearances in the entityhub
  · Temporal clusters — multiple signals within a short window from different sources

SKIP (do not waste characters on):
  · Sub-3 score signals from any source
  · Routine patterns confirming expected behavior (training flights, regular filings)
  · Investigations with no new signals — silence on a known thread is not news
  · Weather unless severe or the reader is traveling

ALWAYS INCLUDE (even on quiet days):
  · Body readiness score — this is the reader's personal ops tempo indicator
  · Location context if AWAY from home base`;

const EDITOR_SYSTEM_PROMPT = `You are an intelligence briefing editor for a journalist monitoring Hudson Valley OSINT. Synthesize raw data into a tight morning brief.

STRUCTURE:
- Start with "**Morning Brief — {date}**"
- End with the footer line exactly as provided
- Under 1800 characters total (hard Discord limit)

${PRIORITY_RUBRIC}

ANALYTICAL TRADECRAFT — apply these principles when synthesizing:

1. CONFIDENCE GRADING: Indicate confidence based on source corroboration.
   - Single-source claims: flag them. "donorwatch alone flags coordinated $88 donations — single-source, unconfirmed"
   - Multi-source corroboration: call it out explicitly. "Both countywatch and contractwatch show Orange County ICE contract activity — high confidence"
   - Do NOT present single-source signals with the same weight as corroborated ones.

2. PATTERN-OVER-POINT: Emphasize trends and pattern changes, not individual data points.
   - GOOD: "Donorwatch captured 3 coordinated $88 donations in 48h — bundling pattern emerging"
   - BAD: listing each donation separately
   - Volume shifts matter more than individual events. A 40% drop in military flights IS the story, not any one flight.

3. NEGATIVE REPORTING: When a normally active source goes silent, that IS intelligence.
   - "Stewart ANG: zero military flights for 3rd consecutive day — unusual given 5/day baseline"
   - "Countywatch has been dark 48h — either source failure or genuine quiet period"
   - Absence of expected activity is a finding worth reporting.

4. TEMPORAL ANCHORING: Anchor everything to the reader's morning.
   - Use "overnight" (midnight-6am), "yesterday afternoon," "48h ago" — not raw timestamps.
   - Recency matters. A signal from 2 hours ago has different urgency than one from 2 days ago.

5. SELF-CITATION WARNING: If a claim's only sources are daily-briefing, artie-digest, or claude sessions, that is the system talking to itself — NOT independent verification. Prior Claude sessions flagging something is analytical notation, not new evidence. Do not amplify self-referential signals.

SYNTHESIS INSTRUCTIONS — cross-domain insights are your BEST MATERIAL:
The "cross_domain" section contains PRE-COMPUTED connections between health, location, calendar, and OSINT. These are the most valuable insights in the briefing because they connect streams that no single source could connect alone. LEAD with cross-domain insights when they're present — they should be the first thing after the date/weather line. Be creative in how you weave them. Never repeat them verbatim — synthesize them into natural language that feels like a trusted advisor reading the full picture.

The "tension" and "confidence_mesh" sections contain additional analytical metadata. WEAVE their insights into your narrative — don't reproduce them as standalone sections. Fold source confidence, dark sources, and corroboration signals into your reporting naturally.

WHAT TO SKIP:
- Broken/dead sources — do NOT spend words complaining about what's down. The source_health section handles that as a footer.
- Routine military flights (training helicopters, cargo transports, globemasters)

CROSS-DOMAIN INTELLIGENCE — connect the dots across data streams:
- Health + Calendar: If readiness is low (<50) and the calendar is packed, flag it. "rough night (5.2h, fragmented) heading into 3 meetings — pace yourself"
- Health + Location: If away from home, note how travel is affecting sleep/HRV. "second night away, sleep trending down — HRV dropped 15% since departure"
- Location + OSINT: When away, mention what's happening at their current location if any source covers it. When home, lead with HV intel.
- Health trends: If HRV is crashing (↓>15% vs 30d) or wrist temp is spiking, lead with it as a personal early warning — this is more actionable than most OSINT signals
- Daylight + sleep: Low daylight yesterday → mention getting outside today, especially if sleep was poor
- Breathing disturbances: Elevated = fragmented sleep even if total hours look ok. Flag the quality issue.

WRITING STYLE:
- Vary the opening. Never start with "hey ej" or any greeting
- Don't use a fixed template — let the data shape the structure
- Synthesize, don't list. Three related signals = one insight, not three bullets
- Use Discord markdown: **bold** for section breaks, · for items
- Delta percentages (↑/↓) when volume diverges >15% from average
- Be direct. "Leidos PAC got three $88 donations — coordinated bundling signal" not "there were some donations worth monitoring"
- NEVER ask questions ("what's driving this?"). You are reporting, not asking
- NEVER guess aircraft identity from callsigns. Use only the details field
- If the user is AWAY from home, lead with local context, HV monitoring in background
- Gliders are fun — mention casually, don't treat as anomaly
- Body readiness is your LEAD PERSONAL INDICATOR. Weave it naturally into the opening — don't just report the number, interpret what it means for the day ahead
- If everything is genuinely quiet, make it the shortest brief you've ever written`;

async function editorPass(rawSections: Record<string, string>, dateStr: string, footer: string): Promise<string> {
  const rawDump = Object.entries(rawSections)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `=== ${k} ===\n${v}`)
    .join('\n\n');

  const userPrompt = `Date: ${dateStr}

Raw intelligence sections:

${rawDump}

Footer (include verbatim at end):
${footer}

Write the morning brief. Under 1800 characters total.`;

  const messages = [
    { role: 'system' as const, content: EDITOR_SYSTEM_PROMPT },
    { role: 'user' as const, content: userPrompt },
  ];

  // Try OpenRouter first, then fall back to OpenAI direct
  let result = '';

  // Attempt 1: OpenRouter
  try {
    const { openRouterService } = await import('../../services/llm/openrouter.js');
    const model = process.env.SMART_MODEL || 'anthropic/claude-sonnet-4';
    result = await openRouterService.generateFromMessageChain(
      messages,
      'morning-briefing-editor',
      undefined,
      model,
      { maxTokens: 2048 }
    );
  } catch (e) {
    logger.warn('Editor pass OpenRouter failed, trying OpenAI direct fallback:', e);
  }

  // Attempt 2: OpenAI direct (bypasses OpenRouter credit issues)
  if (!result && process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 2048,
        temperature: 0.7,
      });
      result = completion.choices[0]?.message?.content?.trim() || '';
      if (result) {
        logger.info('✅ Morning briefing editor used OpenAI direct fallback');
      }
    } catch (e2) {
      logger.error('Editor pass OpenAI fallback also failed:', e2);
    }
  }

  if (!result) {
    logger.error('Editor pass: all LLM attempts failed, falling back to raw assembly');
    return ''; // empty = caller falls back to raw assembly
  }

  // Safety check — if LLM returned something too long, hard-truncate
  if (result.length > 1950) {
    return result.substring(0, 1947) + '...';
  }

  return result;
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

  const footer = '─── [sky](https://skywatch.tools.ejfox.com) · [kanban](https://kanban.tools.ejfox.com) · [health](https://fitness.tools.ejfox.com/insights) · [intel](https://intel.tools.ejfox.com) · [briefings](https://briefings.tools.ejfox.com)';

  // --- Read current location for context ---
  const loc = readJson(LOCATION_FILE);
  const currentLat = loc?.lat || 41.333;
  const currentLon = loc?.lon || -73.885;
  const currentTown = loc?.town?.replace(/^Town of /, '') || 'Putnam Valley';
  const currentCounty = loc?.county || 'Putnam';
  const currentState = loc?.state || 'New York';
  // Check if we're outside Hudson Valley (roughly 40.5-42.5N, 75.5-73.5W)
  const inHV = currentLat >= 40.5 && currentLat <= 42.5 && currentLon >= -75.5 && currentLon <= -73.5;
  // Check ride state for overnight-away context
  let rideStateStr = '';
  try {
    const rs = readJson('/data2/owntracks/ride-state.json');
    if (rs?.state === 'away') {
      rideStateStr = ` Woke up away from home (ride-state: away since ${rs.stateStartedAt?.slice(0, 10)}).`;
    }
  } catch { /* */ }

  const locationContext = inHV
    ? `Currently in ${currentTown}, ${currentCounty} Co. (Hudson Valley home base).${rideStateStr}`
    : `Currently in ${currentTown}, ${currentState} — AWAY FROM HOME BASE.${rideStateStr} Adapt the briefing to this location. HV monitoring continues in background but lead with what's relevant HERE.`;

  // --- Gather all raw data sections ---
  const rawSections: Record<string, string> = {};
  rawSections['location_context'] = locationContext;

  rawSections['weather'] = await generateWeatherSection();
  rawSections['health'] = generateHealthSection();

  const narrative = await fetchHealthNarrative();
  if (narrative) {
    const paragraphs = narrative.split('\n\n').filter(p => p.length > 30 && !p.startsWith('**'));
    rawSections['health_narrative'] = paragraphs[0] || '';
  }

  rawSections['calendar'] = await generateCalendarSection();
  rawSections['mail'] = await generateMailSection();
  rawSections['tasks'] = generateTasksSection();

  // OSINT sections — with day-over-day deltas baked in
  const skyRaw = await generateSkywatchSection();
  const skyAvg = queryDb(DB_PATHS.skywatch,
    "SELECT ROUND(AVG(total_flights)) FROM daily_stats WHERE date >= date('now', '-7 days') AND date < date('now')");
  const skyToday = queryDb(DB_PATHS.skywatch,
    "SELECT COUNT(*) FROM flights WHERE first_seen >= datetime('now', '-24 hours')");
  if (skyRaw) {
    const ft = parseInt(skyToday) || 0;
    const fa = parseInt(skyAvg) || 0;
    rawSections['skywatch'] = skyRaw + (fa > 0 ? `\n  Volume${deltaTag(ft, fa)} vs 7d avg` : '');
  }

  const countyRaw = generateCountySection();
  const countyAvg = queryDb(DB_PATHS.countywatch,
    "SELECT ROUND(COUNT(*) / 7.0) FROM news WHERE first_seen >= datetime('now', '-7 days')");
  const countyToday = queryDb(DB_PATHS.countywatch,
    "SELECT COUNT(*) FROM news WHERE first_seen >= datetime('now', '-24 hours')");
  if (countyRaw) {
    const ct = parseInt(countyToday) || 0;
    const ca = parseInt(countyAvg) || 0;
    rawSections['countywatch'] = countyRaw + (ca > 0 ? `\n  Volume${deltaTag(ct, ca)} vs 7d avg` : '');
  }

  rawSections['contracts'] = generateContractSection();
  rawSections['donors'] = generateDonorSection();
  rawSections['anomalies'] = generateAnomalySection();
  rawSections['masint'] = generateMasintSection();
  rawSections['riverwatch'] = generateRiverwatchSection();
  rawSections['recent_trips'] = generateRecentTrips();
  rawSections['tension'] = generateTensionSection();
  rawSections['confidence_mesh'] = generateConfidenceMesh();
  rawSections['latest_briefing'] = generateBriefingLink();
  rawSections['source_health'] = generateSourceHealth();

  // Location-aware OSINT: surface news/signals relevant to current location
  rawSections['location_intel'] = generateLocationIntel(currentTown, currentCounty, inHV);

  // --- Cross-domain insights: pre-computed connections across data streams ---
  rawSections['cross_domain'] = generateCrossDomainInsights(
    rawSections, currentTown, currentCounty, inHV, currentLat, currentLon
  );

  // --- Save dedup cache for tomorrow's comparison ---
  const tensionText = rawSections['tension'] || '';
  const todayTensionItems = tensionText
    .split('\n')
    .filter(l => l.includes('·'))
    .map(l => l.replace(/^\s*·\s*/, '').trim());

  saveBriefingCache({
    date: new Date().toISOString(),
    silentInvestigations: todayTensionItems.filter(t => t.startsWith('No signals')),
    tensionItems: todayTensionItems,
  });

  // --- Editor pass: LLM synthesizes raw data into a tight brief ---
  const edited = await editorPass(rawSections, dateStr, footer);

  if (edited && edited.length > 100) {
    return edited;
  }

  // --- Fallback: raw assembly if editor fails ---
  const parts: string[] = [];
  parts.push(`**Morning Brief — ${dateStr}**`);

  // Sections ordered by priority; skip empty or low-value ones aggressively
  // to keep the fallback readable within Discord's character limit
  const fallbackSections = ['weather', 'health', 'calendar', 'mail', 'tasks',
    'skywatch', 'countywatch', 'contracts', 'donors', 'anomalies',
    'masint', 'riverwatch', 'tension', 'confidence_mesh', 'latest_briefing',
    'source_health'];

  // Sections that often return empty or trivially short content —
  // in fallback mode, skip them unless they have substantial data
  const lowValueIfShort: Record<string, number> = {
    health: 30,
    calendar: 20,
    mail: 20,
    masint: 20,
    riverwatch: 20,
    health_narrative: 50,
  };

  for (const key of fallbackSections) {
    const val = rawSections[key];
    if (!val) continue;
    const minLen = lowValueIfShort[key] || 0;
    if (val.length < minLen) continue;
    parts.push(val);
  }
  parts.push(footer);

  let result = parts.join('\n\n');
  if (result.length > 1950) {
    // Last resort truncation — cut from the end, keep header + footer
    const maxBody = 1950 - footer.length - 10;
    result = result.substring(0, maxBody) + '\n\n' + footer;
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

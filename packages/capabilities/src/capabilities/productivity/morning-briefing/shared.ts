import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname } from 'path';

// --- Types ---
export interface BriefingConfig {
  userId: string; enabled: boolean; cronTime: string;
  timezone: string; deliveryChannel: 'discord' | 'sms' | 'both';
  lastDelivered?: string;
}
export interface BriefingParams {
  action: string; time?: string; timezone?: string;
  section?: string; channel?: 'discord' | 'sms' | 'both';
  [key: string]: unknown;
}
interface Cache { date: string; tensionItems: string[]; }
export const configs = new Map<string, BriefingConfig>();

// --- Constants ---
export const DB = {
  sky: '/opt/docker/smallweb/data/skywatch/data/skywatch.db',
  county: '/opt/docker/smallweb/data/countywatch/data/countywatch.db',
  contract: '/opt/docker/smallweb/data/contractwatch/data/contractwatch.db',
  donor: '/opt/docker/smallweb/data/donorwatch/data/donorwatch.db',
  anomaly: '/opt/docker/smallweb/data/anomalywatch/data/anomalywatch.db',
  river: '/opt/docker/smallweb/data/riverwatch/data/riverwatch.db',
  health: '/opt/docker/smallweb/data/health-webhook/data/health.db',
  entity: '/opt/docker/smallweb/data/entityhub/data/entityhub.db',
  masint: '/opt/docker/smallweb/data/masintwatch/data/masintwatch.db',
} as const;
export const LOC_FILE = '/data2/owntracks/location-context.json';
export const BRIEFINGS_DIR = '/opt/docker/smallweb/data/briefings/data/reports';
const CACHE_PATH = '/tmp/morning-briefing-last-sections.json';
export const SOURCES = ['skywatch','countywatch','contractwatch','donorwatch','filingwatch','changewatch','masintwatch','redditwatch','riverwatch','egoscan'] as const;
export const SRC_SQL = SOURCES.map(s => `'${s}'`).join(',');
export const N8N_AUTH = `Basic ${Buffer.from('claude:its-ya-boi-claude-676767').toString('base64')}`;
export const ENT_FILTER = "AND LENGTH(e.canonical_name)>5 AND e.canonical_name NOT LIKE '%Committee%' AND e.canonical_name NOT LIKE '%Order %' AND e.canonical_name NOT LIKE '%County%' AND e.canonical_name NOT LIKE '%Board%' AND e.entity_type IN ('person','organization','facility','government_agency')";

// --- Helpers ---
export function q(db: string, sql: string): string {
  try {
    if (!existsSync(db)) return '';
    return execSync(`sqlite3 "${db}" "${sql}"`, { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { return ''; }
}
export function rjson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}
export function timeToCron(t: string): string {
  const m = t.toLowerCase().trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return '0 8 * * *';
  let h = parseInt(m[1]); const min = m[2] ? parseInt(m[2]) : 0;
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return `${min} ${h} * * *`;
}
export function dtag(cur: number, avg: number): string {
  if (avg <= 0) return '';
  const p = Math.round(((cur - avg) / avg) * 100);
  return Math.abs(p) < 15 ? ' →' : p > 0 ? ` ↑${p}%` : ` ↓${Math.abs(p)}%`;
}
const SHORT: Record<string, string> = { skywatch:'sky',countywatch:'county',contractwatch:'contracts',donorwatch:'donors',filingwatch:'filings',changewatch:'changes',masintwatch:'masint',redditwatch:'reddit',riverwatch:'river',egoscan:'ego',honeypot:'honeypot' };
export const ssrc = (s: string) => SHORT[s] || s;
const REL: Record<string, string[]> = {
  skywatch:['flight','aircraft','military','ang','stewart','ice','corridor'],
  countywatch:['ice','detention','county','contract','hudson','chester'],
  contractwatch:['contract','federal','ice','dhs','detention'],
  donorwatch:['election','donor','campaign','political'],
  filingwatch:['sec','filing','corporate','contract','federal'],
  changewatch:['website','policy','ice','detention','county'],
  redditwatch:['stewart','military','ice','hudson','flight','detention'],
  masintwatch:[], riverwatch:['river','vessel','waterway','ferry'], egoscan:[],
};
export const srcRel = (s: string, t: string) => (REL[s]||[]).some(k => t.toLowerCase().includes(k));

export function fmtSec(db: string, cntSql: string, itemSql: string, emoji: string, label: string, trunc = 120): string {
  const n = parseInt(q(db, cntSql)) || 0;
  if (!n) return '';
  const items = q(db, itemSql);
  let r = `${emoji} **${label}** (${n} new)`;
  if (items) r += '\n' + items.split('\n').filter(Boolean).map(l => `  · ${l.substring(0, trunc)}`).join('\n');
  return r;
}

// --- Dedup cache ---
export function loadCache(): Cache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const d = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    return (Date.now() - new Date(d.date).getTime()) / 86400000 > 2 ? null : d;
  } catch { return null; }
}
export function saveCache(items: string[]): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ date: new Date().toISOString(), tensionItems: items }));
  } catch {}
}
export function dedupTension(items: string[], cache: Cache | null): string[] {
  if (!cache) return items;
  const prev = new Set(cache.tensionItems.map(t => t.toLowerCase().trim()));
  return items.filter(i => !i.startsWith('No signals') || !prev.has(i.toLowerCase().trim()));
}

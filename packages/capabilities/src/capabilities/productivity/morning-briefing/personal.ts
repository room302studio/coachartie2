import { logger } from '@coachartie/shared';
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename } from 'path';
import { DB, N8N_AUTH, BRIEFINGS_DIR, q } from './shared.js';

export async function weather(loc: any): Promise<string> {
  try {
    const lat = loc?.lat || 41.333, lon = loc?.lon || -73.885;
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&hourly=precipitation_probability,temperature_2m&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York`, { signal: AbortSignal.timeout(8000) });
    const d: any = await resp.json();
    if (!d.current) return '';
    const temp = Math.round(d.current.temperature_2m), wind = Math.round(d.current.wind_speed_10m);
    const WX: Record<number, string> = { 0:'Clear',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',61:'Rain',63:'Rain',65:'Heavy rain',71:'Snow',73:'Snow',75:'Heavy snow',80:'Showers',81:'Showers',85:'Snow showers',95:'T-storm' };
    const hr = new Date().getHours(), rem = (d.hourly?.temperature_2m || []).slice(hr);
    const high = rem.length ? Math.round(Math.max(...rem)) : null;
    const rp = (d.hourly?.precipitation_probability || []).slice(hr), ri = rp.findIndex((p: number) => p >= 40);
    let line = `${temp}°F, ${WX[d.current.weather_code] || 'WMO ' + d.current.weather_code}, wind ${wind}mph`;
    if (high !== null) line += ` | High ${high}°F`;
    if (ri >= 0) { const rh = hr + ri; line += ` | Rain ${rp[ri]}% ~${rh > 12 ? rh-12 : rh}${rh >= 12 ? 'pm' : 'am'}`; }
    const town = loc?.town?.replace(/^Town of /, '') || 'Putnam Valley';
    let r = `📍 ${town}, ${loc?.county || 'Putnam'} Co. | ${line}`;
    if (loc?.sunset?.sunrise) r += `\n☀️ ${loc.sunset.sunrise} → ${loc.sunset.sunset}`;
    return r;
  } catch (e) {
    logger.warn('Weather failed:', e);
    return loc?.town ? `📍 ${loc.town.replace(/^Town of /, '')} (weather unavailable)` : '';
  }
}

export async function calendar(): Promise<string> {
  try {
    const d: any = await (await fetch('http://localhost:5678/webhook/0c8062e4-50b2-4d7e-b93b-9a08e85f7b83', { signal: AbortSignal.timeout(5000), headers: { Authorization: N8N_AUTH } })).json();
    const raw = Array.isArray(d) ? d : d.events;
    if (!raw?.length) return '📅 Calendar: clear day';
    const seen = new Set<string>();
    const evts = raw.filter((e: any) => !(e.source?.title === 'Reclaim Calendar Sync' || e.extendedProperties?.private?.['reclaim.personalSync']))
      .filter((e: any) => { const k = (e.summary||'').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const lines = evts.slice(0, 5).map((e: any) => {
      const m = String(e.start?.dateTime || e.start || '').match(/T(\d{2}):(\d{2})/);
      return `  · ${m ? `${parseInt(m[1])>12?parseInt(m[1])-12:parseInt(m[1])||12}:${m[2]} ${parseInt(m[1])>=12?'PM':'AM'}` : '?'} ${e.summary||'Untitled'}`;
    }).join('\n');
    return `📅 **Calendar** (${evts.length} today)\n${lines}`;
  } catch { return ''; }
}

export async function mail(): Promise<string> {
  try {
    const d: any = await (await fetch('http://localhost:5678/webhook/eXChuVSVMvtFsN3c/webhook/claude-mail-unread', { signal: AbortSignal.timeout(10000), headers: { Authorization: N8N_AUTH } })).json();
    if (!d.count) return '';
    return `📧 **Mail** (${d.count} unread)\n` + (d.emails||[]).slice(0,3).map((e: any) => `  · ${String(e.from||'?').replace(/<[^>]+>/g,'').replace(/"/g,'').trim().substring(0,20)} — ${String(e.subject||e.snippet||'?').substring(0,55)}`).join('\n');
  } catch { return ''; }
}

export function tasks(): string {
  try {
    const cards = JSON.parse(execSync('KANBAN_TOKEN=$(grep API_TOKEN /opt/docker/smallweb/data/kanban/.env 2>/dev/null | cut -d= -f2) && curl -s --max-time 5 "https://kanban.tools.ejfox.com/api/cards" -H "Authorization: Bearer $KANBAN_TOKEN" 2>/dev/null', { encoding: 'utf-8', timeout: 10000 }) || '[]');
    const active = cards.filter((c: any) => c.lane==='Active').slice(0,3);
    const blocked = cards.filter((c: any) => c.lane==='Blocked').slice(0,2);
    const ready = cards.filter((c: any) => c.lane==='Ready').length;
    const sug = cards.filter((c: any) => c.lane==='Suggested');
    if (!active.length && !blocked.length && !sug.length) return '';
    let t = '📋 **Tasks**';
    for (const c of active) t += `\n  → ${c.title}`;
    for (const c of blocked) t += `\n  ⛔ ${c.title}${c.blocked_reason||c.blockedReason ? ' — '+(c.blocked_reason||c.blockedReason).substring(0,60) : ''}`;
    if (ready) t += `\n  (${ready} ready)`;
    if (sug.length) t += `\n  💡 Review${sug.length>3?` (+${sug.length-3} more)`:''}: ${sug.slice(0,3).map((c: any) => c.title.substring(0,35)).join(' · ')}\n  → [kanban](https://kanban.tools.ejfox.com)`;
    return t;
  } catch { return ''; }
}

export function health(): string {
  const stale = parseInt(q(DB.health, "SELECT ROUND(julianday('now')-julianday(MAX(date))) FROM metrics")) || 999;
  if (stale > 7) return '';
  const sleep = q(DB.health, "SELECT json_extract(raw,'$.totalSleep'),json_extract(raw,'$.deep'),json_extract(raw,'$.rem') FROM metrics WHERE name='sleep_analysis' AND json_extract(raw,'$.totalSleep')>=2.5 ORDER BY date DESC LIMIT 1");
  const sAvg = parseFloat(q(DB.health, "SELECT ROUND(AVG(json_extract(raw,'$.totalSleep')),1) FROM metrics WHERE name='sleep_analysis' AND json_extract(raw,'$.totalSleep')>=2.5 AND date>=date('now','-7 days')")) || 0;
  const h7 = parseInt(q(DB.health, "SELECT ROUND(AVG(COALESCE(qty,avg)),0) FROM metrics WHERE name='heart_rate_variability' AND date>=date('now','-7 days')")) || 0;
  const h30 = parseInt(q(DB.health, "SELECT ROUND(AVG(COALESCE(qty,avg)),0) FROM metrics WHERE name='heart_rate_variability' AND date>=date('now','-30 days')")) || h7;
  const rhr = q(DB.health, "SELECT ROUND(AVG(qty),0) FROM metrics WHERE name='resting_heart_rate' AND date>=date('now','-3 days')");
  const steps = q(DB.health, "SELECT ROUND(SUM(qty)) FROM metrics WHERE name='step_count' AND date(date)=(SELECT MAX(date(date)) FROM metrics WHERE name='step_count' AND date(date)<date('now'))");
  const stAvg = parseInt(q(DB.health, "SELECT ROUND(AVG(ds)) FROM (SELECT SUM(qty) ds FROM metrics WHERE name='step_count' AND date>=date('now','-7 days') GROUP BY date(date))")) || 0;
  const bd = parseFloat(q(DB.health, "SELECT ROUND(qty,1) FROM metrics WHERE name='breathing_disturbances' ORDER BY date DESC LIMIT 1")) || 0;
  const bdA = parseFloat(q(DB.health, "SELECT ROUND(AVG(qty),1) FROM metrics WHERE name='breathing_disturbances' AND date>=date('now','-14 days')")) || bd;
  const wt = parseFloat(q(DB.health, "SELECT ROUND(qty,1) FROM metrics WHERE name='apple_sleeping_wrist_temperature' ORDER BY date DESC LIMIT 1")) || 0;
  const wtA = parseFloat(q(DB.health, "SELECT ROUND(AVG(qty),1) FROM metrics WHERE name='apple_sleeping_wrist_temperature' AND date>=date('now','-14 days')")) || 0;
  const spo2 = q(DB.health, "SELECT ROUND(AVG(qty),1)||'|'||ROUND(MIN(qty),1) FROM metrics WHERE name='blood_oxygen_saturation' AND date=(SELECT MAX(date) FROM metrics WHERE name='blood_oxygen_saturation')");
  const day = parseInt(q(DB.health, "SELECT ROUND(SUM(qty)) FROM metrics WHERE name='time_in_daylight' AND date(date)=(SELECT MAX(date(date)) FROM metrics WHERE name='time_in_daylight' AND date(date)<date('now'))")) || 0;
  const meds = q(DB.health, "SELECT substance||COALESCE(' '||CAST(CAST(dose AS INT) AS TEXT)||unit,'') FROM interventions WHERE date(timestamp)=date('now','-1 day') ORDER BY timestamp");
  if (!sleep && !h7 && !steps) return '';

  const st = sleep ? parseFloat(sleep.split('|')[0]) || 0 : 0;
  let rd = 50;
  if (st >= 7.5) rd += 20; else if (st >= 6.5) rd += 10; else if (st < 5) rd -= 20; else if (st < 6) rd -= 10;
  if (h7 && h30) { if (h7>h30*1.1) rd+=15; else if (h7>h30*1.03) rd+=5; else if (h7<h30*0.85) rd-=15; else if (h7<h30*0.95) rd-=5; }
  if (bd && bdA) { if (bd>bdA*1.5) rd-=10; else if (bd<bdA*0.7) rd+=5; }
  rd = Math.max(0, Math.min(100, rd));

  let r = `🏥 **Health**\n  ${rd>=75?'🟢':rd>=50?'🟡':'🔴'} Body readiness: ${rd}/100`;
  if (sleep) {
    const [tot,deep,rem] = sleep.split('|').map(Number);
    r += `\n  ${tot>=7.5?'✅':tot>=6?'⚠️':'🔴'} Sleep: ${tot.toFixed(1)}h${sAvg?` (7d avg ${sAvg}h)`:''} — deep ${deep.toFixed(1)}h, REM ${rem.toFixed(1)}h`;
    if (bd && bdA && bd > bdA*1.5) r += ` ⚠️ breathing disturbances elevated (${bd} vs avg ${bdA})`;
  }
  if (h7) r += `\n  HRV: ${h7}ms ${h7>h30*1.05?'↑':h7<h30*0.95?'↓':'→'} (30d: ${h30}) · RHR: ${rhr||'?'}bpm`;
  else if (rhr) r += `\n  RHR: ${rhr}bpm`;
  if (wt && wtA && Math.abs(wt-wtA)>0.5) { const d=wt-wtA; r+=`\n  🌡️ Wrist temp ${d>0?'↑':'↓'}${Math.abs(d).toFixed(1)}°F from baseline — ${d>0.8?'possible illness onset':'notable deviation'}`; }
  if (spo2) { const [a,m]=spo2.split('|').map(Number); if (m<95) r+=`\n  🫁 SpO2 dipped to ${m}% overnight (avg ${a}%)`; }
  if (steps) { const s=parseInt(steps)||0; r+=`\n  Steps: ${s.toLocaleString()}${stAvg?` (7d avg ${stAvg.toLocaleString()})`:''}`; }
  if (day>0) r += `\n  ☀️ ${day}min daylight yesterday${day<30?' — low, get outside today':day>120?' — solid outdoor time':''}`;
  if (meds) { const items=meds.split('\n').filter(Boolean); if (items.length) r+=`\n  💊 ${items.join(', ')}`; }
  return r;
}

export async function healthNarrative(): Promise<string> {
  try {
    const d: any = await (await fetch('https://fitness.tools.ejfox.com/api/narrative', { signal: AbortSignal.timeout(10000) })).json();
    const n = d?.narrative || '';
    if (!n || n.startsWith('(')) return '';
    return n.split('\n\n').filter((p: string) => p.length > 30 && !p.startsWith('**'))[0] || '';
  } catch { return ''; }
}

export function briefingLink(): string {
  try {
    const f = execSync(`ls -t ${BRIEFINGS_DIR}/*.md 2>/dev/null | head -1`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!f) return '';
    return `📄 **Latest briefing** (${Math.round((Date.now()-statSync(f).mtimeMs)/3600000)}h ago): ${readFileSync(f,'utf-8').split('\n')[0].replace(/^#\s*/,'')}\n  → https://briefings.tools.ejfox.com/report/${basename(f,'.md')}`;
  } catch { return ''; }
}

export function recentTrips(): string {
  try {
    const dir = '/data2/owntracks/ride-logs';
    if (!existsSync(dir)) return '';
    const yday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    const files = readdirSync(dir).filter(f => f.endsWith('.json') && f >= yday).sort().reverse().slice(0,3);
    if (!files.length) return '';
    const trips = files.map(f => { try {
      const l = JSON.parse(readFileSync(`${dir}/${f}`,'utf-8'));
      const h=Math.floor(l.durationMinutes/60), m=l.durationMinutes%60;
      return `  · ${l.motorcycle?'🏍️':'🗺️'} ${h?h+'h'+(m?m+'m':''):m+'m'}, ${l.distanceMiles}mi — ${(l.countiesTraversed||[]).join(' → ')}${l.elevationGainFt>100?` ↑${l.elevationGainFt}ft`:''}`;
    } catch { return null; } }).filter(Boolean);
    return trips.length ? `Recent trips:\n${trips.join('\n')}` : '';
  } catch { return ''; }
}

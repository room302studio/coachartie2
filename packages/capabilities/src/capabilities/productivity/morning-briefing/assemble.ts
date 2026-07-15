import { LOC_FILE, DB, q, rjson, dtag, saveCache } from './shared.js';
import { weather, calendar, mail, tasks, health, healthNarrative, briefingLink, recentTrips } from './personal.js';
import { skywatch, county, contracts, donors, anomalies, masint, riverwatch, tension, confidence, crossDomain, locationIntel, sourceHealth } from './intel.js';
import { editorPass } from './editor.js';
import type { BriefingConfig } from './shared.js';

const FOOTER = '─── [sky](https://skywatch.tools.ejfox.com) · [kanban](https://kanban.tools.ejfox.com) · [health](https://fitness.tools.ejfox.com/insights) · [intel](https://intel.tools.ejfox.com) · [briefings](https://briefings.tools.ejfox.com)';

export async function generateBriefing(_config: BriefingConfig): Promise<string> {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const loc = rjson(LOC_FILE);
  const lat = loc?.lat||41.333, lon = loc?.lon||-73.885;
  const town = loc?.town?.replace(/^Town of /,'')||'Putnam Valley', cnty = loc?.county||'Putnam', state = loc?.state||'New York';
  const inHV = lat>=40.5 && lat<=42.5 && lon>=-75.5 && lon<=-73.5;
  let ride = '';
  try { const rs = rjson('/data2/owntracks/ride-state.json'); if (rs?.state==='away') ride = ` Woke up away from home (ride-state: away since ${rs.stateStartedAt?.slice(0,10)}).`; } catch {}

  const s: Record<string,string> = {};
  s['location_context'] = inHV ? `Currently in ${town}, ${cnty} Co. (Hudson Valley home base).${ride}` : `Currently in ${town}, ${state} — AWAY FROM HOME BASE.${ride} Lead with what's relevant HERE.`;
  s['weather'] = await weather(loc);
  s['health'] = health();
  const narr = await healthNarrative();
  if (narr) { const p = narr.split('\n\n').filter((x: string) => x.length>30 && !x.startsWith('**')); s['health_narrative'] = p[0]||''; }
  s['calendar'] = await calendar();
  s['mail'] = await mail();
  s['tasks'] = tasks();

  const skyRaw = await skywatch();
  if (skyRaw) { const a=parseInt(q(DB.sky,"SELECT ROUND(AVG(total_flights)) FROM daily_stats WHERE date>=date('now','-7 days') AND date<date('now')"))||0, t=parseInt(q(DB.sky,"SELECT COUNT(*) FROM flights WHERE first_seen>=datetime('now','-24 hours')"))||0; s['skywatch']=skyRaw+(a?`\n  Volume${dtag(t,a)} vs 7d avg`:''); }
  const cRaw = county();
  if (cRaw) { const a=parseInt(q(DB.county,"SELECT ROUND(COUNT(*)/7.0) FROM news WHERE first_seen>=datetime('now','-7 days')"))||0, t=parseInt(q(DB.county,"SELECT COUNT(*) FROM news WHERE first_seen>=datetime('now','-24 hours')"))||0; s['countywatch']=cRaw+(a?`\n  Volume${dtag(t,a)} vs 7d avg`:''); }

  s['contracts']=contracts(); s['donors']=donors(); s['anomalies']=anomalies();
  s['masint']=masint(); s['riverwatch']=riverwatch(); s['recent_trips']=recentTrips();
  s['tension']=tension(); s['confidence_mesh']=confidence();
  s['latest_briefing']=briefingLink(); s['source_health']=sourceHealth();
  s['location_intel']=locationIntel(town, cnty, inHV);
  s['cross_domain']=crossDomain(s, town, cnty, inHV, lat, lon);

  // Save dedup cache
  const tItems = (s['tension']||'').split('\n').filter(l => l.includes('·')).map(l => l.replace(/^\s*·\s*/,'').trim());
  saveCache(tItems);

  const edited = await editorPass(s, dateStr, FOOTER);
  if (edited && edited.length > 100) return edited;

  // Fallback: raw assembly
  const parts = [`**Morning Brief — ${dateStr}**`];
  const order = ['weather','health','calendar','mail','tasks','skywatch','countywatch','contracts','donors','anomalies','masint','riverwatch','tension','confidence_mesh','latest_briefing','source_health'];
  const mins: Record<string,number> = { health:30, calendar:20, mail:20, masint:20, riverwatch:20 };
  for (const k of order) { const v=s[k]; if (v && v.length>=(mins[k]||0)) parts.push(v); }
  parts.push(FOOTER);
  let result = parts.join('\n\n');
  if (result.length > 1950) result = result.substring(0, 1950-FOOTER.length-10) + '\n\n' + FOOTER;
  return result;
}

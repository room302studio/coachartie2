import { logger } from '@coachartie/shared';
import { DB, SOURCES, SRC_SQL, ENT_FILTER, q, rjson, fmtSec, ssrc, srcRel, loadCache, dedupTension } from './shared.js';

export async function skywatch(): Promise<string> {
  const fc = parseInt(q(DB.sky, "SELECT COUNT(*) FROM flights WHERE first_seen>=datetime('now','-24 hours')")) || 0;
  const nc = parseInt(q(DB.sky, "SELECT COUNT(*) FROM notable WHERE spotted_at>=datetime('now','-24 hours')")) || 0;
  if (!nc && !fc) return '';
  const notables = q(DB.sky,
    `SELECT callsign||' — '||REPLACE(details,'; ',' | ') FROM notable
     WHERE date(spotted_at)>=date('now','-1 day')
     AND reason NOT LIKE '%low_altitude_military_zone%' AND reason NOT LIKE '%new_aircraft%' OR reason NOT LIKE '%new_aircraft'
     AND callsign NOT LIKE '0%' AND callsign NOT LIKE 'EPIC%'
     GROUP BY callsign ORDER BY
       CASE WHEN reason LIKE '%watchlist%' THEN 0 WHEN reason LIKE '%military%' THEN 1 WHEN reason LIKE '%foreign%' THEN 1
            WHEN reason LIKE '%emergency%' THEN 0 WHEN reason LIKE '%plane_alert_db%' THEN 2 ELSE 3 END,
       MAX(spotted_at) DESC LIMIT 5`);
  let r = `✈️ **Skywatch**: ${fc} flights, ${nc} notable`;
  if (notables) r += '\n' + notables.split('\n').filter(Boolean).map(l => `  · ${l}`).join('\n');
  return r;
}

export function county(): string {
  const nc = parseInt(q(DB.county, "SELECT COUNT(*) FROM news WHERE first_seen>=datetime('now','-24 hours')")) || 0;
  if (!nc) return '';
  const HARD_NEWS = "title LIKE '%crash%' OR title LIKE '%arrest%' OR title LIKE '%fire%' OR title LIKE '%killed%' OR title LIKE '%dead%' OR title LIKE '%emergency%' OR title LIKE '%ICE%' OR title LIKE '%shooting%' OR title LIKE '%flood%' OR title LIKE '%explosion%' OR title LIKE '%missing%' OR title LIKE '%indicted%' OR title LIKE '%charged%' OR title LIKE '%budget%' OR title LIKE '%vote%' OR title LIKE '%resolution%'";
  // Only show hard news — skip section entirely on listicle-only days
  const top = q(DB.county,
    `SELECT title FROM news WHERE first_seen>=datetime('now','-48 hours')
     AND title NOT LIKE '%Horoscope%' AND title NOT LIKE '%horoscope%' AND title NOT LIKE '%Daily Crossword%' AND title NOT LIKE '%Recipe%' AND title NOT LIKE '%Best % to Buy%'
     AND title NOT LIKE '%Guide%' AND title NOT LIKE '%Favorites%' AND title NOT LIKE '%Fun in%'
     ORDER BY CASE WHEN ${HARD_NEWS} THEN 0 ELSE 1 END, first_seen DESC LIMIT 3`);
  if (!top) return `📰 **County** (${nc} new, no hard news)`;
  // Check if any of the top 3 are actually hard news (priority 0) — if all are fluff, suppress
  const hardCount = parseInt(q(DB.county, `SELECT COUNT(*) FROM news WHERE first_seen>=datetime('now','-48 hours') AND (${HARD_NEWS})`)) || 0;
  let r = `📰 **County** (${nc} new)`;
  if (!hardCount) return `📰 **County** (${nc} new, quiet day)`;
  r += '\n' + top.split('\n').filter(Boolean).map(l => `  · ${l.replace(/&#\d+;/g,m=>String.fromCharCode(parseInt(m.slice(2,-1)))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').substring(0,100)}`).join('\n');
  return r;
}

export const contracts = () => fmtSec(DB.contract,
  "SELECT COUNT(*) FROM contracts WHERE first_seen>=datetime('now','-24 hours')",
  "SELECT agency||' → '||recipient_name||' $'||printf('%.0f',award_amount) FROM contracts WHERE first_seen>=datetime('now','-24 hours') ORDER BY award_amount DESC LIMIT 2",
  '💰', 'Contracts');

export function donors(): string {
  const n = parseInt(q(DB.donor, "SELECT COUNT(*) FROM contributions WHERE first_seen>=datetime('now','-24 hours')")) || 0;
  if (!n) return '';
  const big = q(DB.donor, "SELECT contributor_name||' → '||committee_name||' $'||printf('%.0f',amount) FROM contributions WHERE first_seen>=datetime('now','-24 hours') AND amount>=500 ORDER BY amount DESC LIMIT 2");
  let r = `🗳️ **Donors**: ${n} new contributions today`;
  if (big) r += '\n' + big.split('\n').filter(Boolean).map(l => `  · ${l.substring(0,90)}`).join('\n');
  return r;
}

export function anomalies(): string {
  const a = q(DB.anomaly, `SELECT title||' ['||printf('%.1f',MAX(final_score))||']' FROM signals WHERE final_score>4 AND timestamp>datetime('now','-3 days') AND title NOT LIKE '%TEST%' AND title NOT LIKE '%OSINT Health%' AND title NOT LIKE '%Health Check%' AND source NOT LIKE 'osint-health%' AND source!='overwatch' AND source!='polymarket' AND source!='egoscan' AND source!='claude' GROUP BY title ORDER BY MAX(final_score) DESC LIMIT 3`);
  if (!a) return '';
  return '⚡ **Anomalies**\n' + a.split('\n').filter(Boolean).map(l => `  · ${l}`).join('\n');
}

export function masint(): string {
  const evts = q(DB.masint, "SELECT source||': '||title FROM events WHERE first_seen>=datetime('now','-24 hours') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,first_seen DESC LIMIT 5");
  if (!evts) return '';
  const n = parseInt(q(DB.masint, "SELECT COUNT(*) FROM events WHERE first_seen>=datetime('now','-24 hours')")) || 0;
  const avg = parseInt(q(DB.masint, "SELECT ROUND(COUNT(*)/7.0) FROM events WHERE first_seen>=datetime('now','-7 days')")) || 0;
  return `MASINT: ${n} events${avg?` (avg ${avg}/day)`:''}\n` + evts.split('\n').filter(Boolean).map(l => `  · ${l.substring(0,120)}`).join('\n');
}

export function riverwatch(): string {
  const nc = parseInt(q(DB.river, "SELECT COUNT(*) FROM notable_vessels WHERE spotted_at>=datetime('now','-24 hours')")) || 0;
  if (!nc) return '';
  const v = q(DB.river, "SELECT name||' ('||flag_reason||')' FROM notable_vessels WHERE spotted_at>=datetime('now','-24 hours') GROUP BY mmsi ORDER BY MAX(spotted_at) DESC LIMIT 3");
  let r = `River: ${nc} notable vessels`;
  if (v) r += '\n' + v.split('\n').filter(Boolean).map(l => `  · ${l.substring(0,100)}`).join('\n');
  return r;
}

export function tension(): string {
  const t: string[] = [];
  // Military volume divergence
  const mt = parseInt(q(DB.sky, "SELECT COALESCE(military_flights,0) FROM daily_stats WHERE date=date('now','-1 day')")) || 0;
  const ma = parseInt(q(DB.sky, "SELECT ROUND(AVG(military_flights),0) FROM daily_stats WHERE date>=date('now','-15 days') AND date<date('now','-1 day')")) || 0;
  if (ma > 5 && Math.abs(mt-ma)/ma >= 0.3) t.push(`Military flights yesterday: ${mt} vs ${ma} avg/14d (${mt>ma?'↑':'↓'}${Math.round(Math.abs(mt-ma)/ma*100)}%)`);
  // Total flight divergence
  const ft = parseInt(q(DB.sky, "SELECT COALESCE(total_flights,0) FROM daily_stats WHERE date=date('now','-1 day')")) || 0;
  const fa = parseInt(q(DB.sky, "SELECT ROUND(AVG(total_flights),0) FROM daily_stats WHERE date>=date('now','-15 days') AND date<date('now','-1 day')")) || 0;
  if (fa > 100 && Math.abs(ft-fa)/fa >= 0.3) t.push(`Total flights yesterday: ${ft} vs ${fa} avg/14d (${ft>fa?'↑':'↓'}${Math.round(Math.abs(ft-fa)/fa*100)}%)`);
  // Opposite-direction divergence: military and civilian moving in opposite directions
  if (ma > 5 && fa > 100 && mt !== 0 && ft !== 0) {
    const milDir = mt > ma ? 1 : mt < ma ? -1 : 0;
    const civDir = ft > fa ? 1 : ft < fa ? -1 : 0;
    if (milDir !== 0 && civDir !== 0 && milDir !== civDir) t.push(`Split pattern: military ${milDir<0?'↓':'↑'} while civilian ${civDir<0?'↓':'↑'} — unusual divergence`);
  }
  // Single-source high signals
  const ss = q(DB.anomaly, `SELECT s.source,SUBSTR(s.title,1,70),ROUND(s.final_score,1) FROM signals s WHERE s.final_score>=6 AND s.ingested_at>=datetime('now','-48 hours') AND s.source IN (${SRC_SQL}) AND s.source NOT IN ('polymarket','egoscan','rescuetime') AND s.id NOT IN (SELECT isig.signal_id FROM investigation_signals isig JOIN investigation_signals isig2 ON isig.investigation_id=isig2.investigation_id JOIN signals s2 ON isig2.signal_id=s2.id WHERE s2.source!=s.source AND s2.source IN (${SRC_SQL}) AND s2.ingested_at>=datetime('now','-48 hours')) ORDER BY s.final_score DESC LIMIT 2`);
  if (ss) for (const l of ss.split('\n').filter(Boolean)) { const p=l.split('|'); if (p.length>=3) t.push(`Single-source: ${p[0]}: ${p[1]} [${p[2]}]`); }
  // Cross-source entity tension
  const et = q(DB.entity, `SELECT sub.name,GROUP_CONCAT(sub.app,', ') FROM (SELECT DISTINCT e.canonical_name as name,em.app_name as app,e.id FROM entities e JOIN entity_mentions em ON e.id=em.entity_id WHERE em.timestamp>=datetime('now','-48 hours') AND em.app_name IN (${SRC_SQL}) ${ENT_FILTER}) sub GROUP BY sub.id HAVING COUNT(sub.app)>=2 ORDER BY COUNT(sub.app) DESC LIMIT 2`);
  if (et) for (const l of et.split('\n').filter(Boolean)) { const p=l.split('|'); if (p.length>=2) t.push(`Multi-source: ${p[0]} (${p[1]})`); }
  // Silent investigations
  const si = q(DB.anomaly, `SELECT i.title FROM investigations i WHERE i.status='active' AND i.id NOT IN (SELECT isig.investigation_id FROM investigation_signals isig JOIN signals s ON isig.signal_id=s.id WHERE s.ingested_at>=datetime('now','-48 hours') AND s.source IN (${SRC_SQL})) LIMIT 2`);
  if (si) for (const l of si.split('\n').filter(Boolean)) t.push(`No signals 48h: ${l}`);
  // Velocity changes
  const vd = q(DB.anomaly, `SELECT i.title,COALESCE(r.cnt,0),COALESCE(b.avg,0) FROM investigations i LEFT JOIN (SELECT isig.investigation_id,COUNT(*) cnt FROM investigation_signals isig JOIN signals s ON isig.signal_id=s.id WHERE s.ingested_at>=datetime('now','-24 hours') GROUP BY isig.investigation_id) r ON i.id=r.investigation_id LEFT JOIN (SELECT isig.investigation_id,ROUND(COUNT(*)/7.0,1) avg FROM investigation_signals isig JOIN signals s ON isig.signal_id=s.id WHERE s.ingested_at>=datetime('now','-7 days') AND s.ingested_at<datetime('now','-24 hours') GROUP BY isig.investigation_id) b ON i.id=b.investigation_id WHERE i.status='active' AND b.avg>=1`);
  if (vd) for (const l of vd.split('\n').filter(Boolean)) {
    const p=l.split('|'); if (p.length<3) continue;
    const last=parseFloat(p[1])||0, avg=parseFloat(p[2])||0; if (!avg) continue;
    const ratio=last/avg;
    if (ratio>2) t.push(`Accelerating: ${p[0].trim()} — ${last} signals/24h vs ${avg} avg/day (${ratio.toFixed(1)}x)`);
    else if (ratio<0.25) t.push(`Decelerating: ${p[0].trim()} — ${last} signals/24h vs ${avg} avg/day (${ratio.toFixed(1)}x)`);
  }
  const filtered = dedupTension(t, loadCache());
  return filtered.length ? '🔀 **Tension**\n' + filtered.map(x => `  · ${x}`).join('\n') : '';
}

export function confidence(): string {
  const sl = SOURCES.map(s => `'${s}'`).join(',');
  const lines: string[] = [];
  // Per-investigation coverage
  const inv = q(DB.anomaly, `SELECT sub.id,sub.title,GROUP_CONCAT(sub.source) FROM (SELECT DISTINCT i.id,i.title,s.source FROM investigations i JOIN investigation_signals isig ON i.id=isig.investigation_id JOIN signals s ON isig.signal_id=s.id WHERE i.status='active' AND s.ingested_at>=datetime('now','-7 days') AND s.source IN (${sl})) sub GROUP BY sub.id ORDER BY COUNT(*) DESC`);
  if (inv) for (const l of inv.split('\n').filter(Boolean)) {
    const p=l.split('|'); if (p.length<3) continue;
    const active=p[2].split(',').filter(Boolean);
    const silent=SOURCES.filter(s => !active.includes(s) && srcRel(s,p[1]));
    let e = `${p[1].replace(/ Regional Activity| Detention Complex/g,'').substring(0,25)}: ${active.map(ssrc).join(', ')}`;
    if (silent.length && silent.length<=4) e += ` · silent: ${silent.map(ssrc).join(', ')}`;
    lines.push(e);
  }
  // Orphan signals
  const orph = q(DB.anomaly, `SELECT s.source,SUBSTR(s.title,1,45),ROUND(s.final_score,1) FROM signals s WHERE s.final_score>=5 AND s.ingested_at>=datetime('now','-48 hours') AND s.source IN (${sl}) AND s.id NOT IN (SELECT signal_id FROM investigation_signals) AND s.title NOT LIKE '%TEST%' AND s.title NOT LIKE '%OSINT Health%' ORDER BY s.final_score DESC LIMIT 2`);
  if (orph) for (const l of orph.split('\n').filter(Boolean)) { const p=l.split('|'); if (p.length>=3) lines.push(`⚠ ${p[1].trim()} [${ssrc(p[0])} only, ${p[2]}]`); }
  // New entities
  const ne = q(DB.entity, `SELECT e.canonical_name,e.entity_type,COUNT(em.id),GROUP_CONCAT(DISTINCT em.app_name) FROM entities e JOIN entity_mentions em ON e.id=em.entity_id WHERE e.first_seen>=datetime('now','-48 hours') ${ENT_FILTER} GROUP BY e.id HAVING COUNT(em.id)>=2 ORDER BY COUNT(em.id) DESC LIMIT 3`);
  if (ne) for (const l of ne.split('\n').filter(Boolean)) { const p=l.split('|'); if (p.length>=4) lines.push(`New ${p[1].trim()}: ${p[0].trim()} (${p[2].trim()} mentions — ${p[3].trim()})`); }
  // Source liveness
  const alive = new Set((q(DB.anomaly, `SELECT DISTINCT source FROM signals WHERE ingested_at>=datetime('now','-24 hours') AND source IN (${sl})`)||'').split('\n').filter(Boolean));
  const dark = SOURCES.filter(s => !alive.has(s) && !['honeypot','masintwatch'].includes(s));
  if (dark.length) lines.push(`Dark 24h: ${dark.map(ssrc).join(', ')}`);
  // Came back online
  const back = SOURCES.filter(s => alive.has(s) && !['honeypot','masintwatch'].includes(s) && !(parseInt(q(DB.anomaly, `SELECT COUNT(*) FROM signals WHERE source='${s}' AND ingested_at>=datetime('now','-72 hours') AND ingested_at<datetime('now','-24 hours')`))||0));
  if (back.length) lines.push(`Came back online: ${back.map(ssrc).join(', ')} (was dark >48h)`);
  return lines.length ? '🔍 **Confidence**\n' + lines.map(l => `  · ${l}`).join('\n') : '';
}

export function crossDomain(sections: Record<string,string>, town: string, county: string, inHV: boolean, lat: number, lon: number): string {
  const ins: string[] = [];
  try {
    const hp = sections['health']||'', cal = sections['calendar']||'';
    const rdm = hp.match(/Body readiness: (\d+)\/100/), rd = rdm ? parseInt(rdm[1]) : -1;
    const mm = cal.match(/\((\d+) today\)/), mc = mm ? parseInt(mm[1]) : 0;
    if (rd>=0 && mc>0) {
      if (rd<50 && mc>=3) ins.push(`⚡ CAPACITY WARNING: readiness ${rd}/100 heading into ${mc} meetings — consider rescheduling non-essential calls`);
      else if (rd<40 && mc>=1) ins.push(`⚡ LOW READINESS (${rd}/100) with ${mc} on the calendar — protect your energy today`);
      else if (rd>=80 && mc<=1) ins.push(`⚡ high readiness (${rd}/100), light calendar — good day for deep work or investigation`);
      else if (rd>=75 && mc>=3) ins.push(`⚡ well-rested (${rd}/100) into a packed day (${mc} events) — good shape for it`);
    }
    // Travel sleep impact
    const rs = rjson('/data2/owntracks/ride-state.json');
    if (rs?.state==='away' && rs?.stateStartedAt) {
      const days = Math.floor((Date.now()-new Date(rs.stateStartedAt).getTime())/86400000);
      if (days >= 2) {
        const dep = rs.stateStartedAt.slice(0,10);
        const since = parseFloat(q(DB.health, `SELECT ROUND(AVG(json_extract(raw,'$.totalSleep')),1) FROM metrics WHERE name='sleep_analysis' AND json_extract(raw,'$.totalSleep')>=2.5 AND date>='${dep}'`)) || 0;
        const before = parseFloat(q(DB.health, `SELECT ROUND(AVG(json_extract(raw,'$.totalSleep')),1) FROM metrics WHERE name='sleep_analysis' AND json_extract(raw,'$.totalSleep')>=2.5 AND date<'${dep}' AND date>=date('${dep}','-7 days')`)) || 0;
        if (since && before) { const d=since-before; if (d<-0.5) ins.push(`🧳 travel is costing you sleep: ${since}h avg since leaving (day ${days}) vs ${before}h at home — ${Math.abs(d).toFixed(1)}h deficit/night`); else if (d>0.5) ins.push(`🧳 sleeping better on the road: ${since}h avg (day ${days} away) vs ${before}h at home`); }
      }
    }
    // Sleep × daylight
    const dlm = hp.match(/(\d+)min daylight yesterday/), slm = hp.match(/Sleep: ([\d.]+)h/), brm = hp.match(/breathing disturbances elevated/);
    if (dlm && slm) {
      const dm=parseInt(dlm[1]), sh=parseFloat(slm[1]);
      if (dm<30 && sh<7) ins.push(`🌙 only ${dm}min daylight yesterday → ${sh}h sleep. outdoor time before noon helps reset circadian rhythm`);
      else if (dm>90 && sh>=7.5 && !brm) ins.push(`🌙 ${dm}min daylight → ${sh}h clean sleep. the pattern holds — keep getting outside`);
      else if (dm>=30 && dm<=60 && sh>=7 && !brm) ins.push(`🌙 moderate daylight (${dm}min) and decent sleep (${sh}h) — more outdoor time could push sleep quality higher`);
    }
    // HRV × OSINT tempo
    const hm = hp.match(/HRV: (\d+)ms (↑|↓|→) \(30d: (\d+)\)/);
    if (hm) {
      const drop = parseInt(hm[3])>0 ? (parseInt(hm[3])-parseInt(hm[1]))/parseInt(hm[3]) : 0;
      const hot = (sections['anomalies']||'').includes('score >=') || (sections['tension']||'').includes('multi-source');
      if (drop>0.15 && hot) ins.push(`📡 HRV down ${Math.round(drop*100)}% while signal tempo is elevated — physiological stress aligning with intel activity`);
      else if (drop>0.2 && !hot) ins.push(`📡 HRV down ${Math.round(drop*100)}% but OSINT is quiet — the stress signal is personal, not external`);
    }
    // Wrist temp illness warning
    const tm = hp.match(/Wrist temp (↑|↓)([\d.]+)°F from baseline/);
    if (tm && tm[1]==='↑' && parseFloat(tm[2])>0.8) ins.push(`🌡️ wrist temp elevated ${tm[2]}°F ${brm?'with fragmented sleep':''} — classic pre-illness pattern. consider clearing tomorrow's calendar`);
    // Location × river
    if (inHV && lon>=-74.05 && lon<=-73.85) { const rv=sections['riverwatch']||''; if (rv.includes('notable')) ins.push(`🚢 you're near the river and there's vessel activity — ${rv.split('\n')[0]}`); }
    // Entity cross-matching
    const names = new Map<string,string[]>();
    const extract = (text: string, src: string) => { let m; const re=/\b([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g; while ((m=re.exec(text))) { if (['Hudson Valley','Orange County','Putnam County','New York','United States','Morning Brief','Coach Artie','Body readiness'].includes(m[1])) continue; if (!names.has(m[1])) names.set(m[1],[]); const s=names.get(m[1])!; if (!s.includes(src)) s.push(src); } };
    extract(sections['donors']||'','donors'); extract(sections['countywatch']||'','news'); extract(sections['contracts']||'','contracts');
    const cross = [...names.entries()].filter(([,s]) => s.length>=2).map(([n,s]) => `${n} (${s.join(' + ')})`);
    if (cross.length) ins.push(`🔗 cross-source entities: ${cross.slice(0,3).join(', ')} — same names appearing in multiple streams`);
  } catch (e) { logger.warn('Cross-domain error:', e); }
  return ins.length ? `🧠 **Cross-Domain Insights**\n${ins.map(i => `  ${i}`).join('\n')}` : '';
}

export function locationIntel(town: string, county: string, inHV: boolean): string {
  if (!town && !county) return '';
  try {
    const tc = town.replace(/^Town of |^City of /,'');
    const parts: string[] = [];
    const news = q(DB.county, `SELECT title,source FROM news WHERE first_seen>=datetime('now','-48 hours') AND (title LIKE '%${tc}%' OR title LIKE '%${county}%') ORDER BY first_seen DESC LIMIT 3`);
    if (news) for (const l of news.split('\n').filter(Boolean)) parts.push(`· ${l.substring(0,120)}`);
    const sig = q(DB.anomaly, `SELECT title FROM signals WHERE created_at>=datetime('now','-48 hours') AND (title LIKE '%${tc}%' OR title LIKE '%${county}%') AND final_score>=2.0 ORDER BY final_score DESC LIMIT 2`);
    if (sig) for (const l of sig.split('\n').filter(Boolean)) parts.push(`· ${l.substring(0,120)}`);
    if (!inHV) { const c=q(DB.contract, `SELECT title FROM contracts WHERE first_seen>=datetime('now','-7 days') AND (title LIKE '%${county}%' OR title LIKE '%${tc}%') LIMIT 2`); if (c) for (const l of c.split('\n').filter(Boolean)) parts.push(`· ${l.substring(0,120)}`); }
    return parts.length ? `📍 **Near you (${tc})**\n${parts.join('\n')}` : '';
  } catch { return ''; }
}

export function sourceHealth(): string {
  const checks = [
    { n:'sky', db:DB.sky, t:'flights', c:'first_seen' },
    { n:'county', db:DB.county, t:'news', c:'first_seen' },
    { n:'contracts', db:DB.contract, t:'contracts', c:'first_seen' },
    { n:'donors', db:DB.donor, t:'contributions', c:'first_seen' },
    { n:'river', db:DB.river, t:'notable_vessels', c:'spotted_at' },
  ];
  const dead = checks.map(s => { const h=parseInt(q(s.db,`SELECT ROUND((julianday('now')-julianday(MAX(${s.c})))*24) FROM ${s.t}`))||0; return h>48?`${s.n} ${Math.round(h/24)}d`:null; }).filter(Boolean);
  return dead.length ? `⚠️ dark: ${dead.join(', ')}` : '';
}

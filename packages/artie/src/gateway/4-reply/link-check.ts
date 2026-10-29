/**
 * Link check: before a reply goes out, every URL in it is fetched, and one that is plainly dead
 * (404/410, or a host that doesn't resolve) is taken out. Asked for the full 1.7.27 notes, Artie
 * pointed a Subway Builder thread at subwaybuilder.com/whatsnew, a page that never existed
 * (EJ, 2026-10-29). Anything short of plainly dead (403, 429, 5xx, timeouts) keeps its link:
 * this catches invented pages, it doesn't judge flaky sites.
 *
 * Bare domains with a path count as links too, since that's how the bad one was written.
 * Loopback/private hosts are never fetched, so a reply can't make the bot probe its own network.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { logger } from '../../shared/logger.js';

const TIMEOUT_MS = 4000;
const MAX_LINKS = 8;
const CACHE_MS = 60 * 60_000;
export const DEAD_LINK_NOTE = '(link unverified)';

// Full URLs, and bare domain/path ones on common TLDs ("subwaybuilder.com/whatsnew").
const URL_RE =
  /\bhttps?:\/\/[^\s<>()`*]+[^\s<>()`*.,;:!?'"\]]|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|gg|dev|app|co|ai|me|tv|xyz|edu|gov)\/[^\s<>()`*]*[^\s<>()`*.,;:!?'"\]]/gi;
// Domains Artie links to constantly and that answer bots badly: Discord message links are real by
// construction (he only has the ids he's seen).
const SKIP_HOSTS = /(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net)$/i;

const cache = new Map<string, { at: number; dead: boolean }>();

function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  const [a, b] = v4.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** True only when the link is plainly dead. */
export async function isDeadLink(raw: string): Promise<boolean> {
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.dead;

  let dead = false;
  try {
    const host = new URL(url).hostname;
    if (SKIP_HOSTS.test(host) || host === 'localhost' || isIP(host)) return false;
    let address: string;
    try {
      address = (await lookup(host)).address;
    } catch (error: any) {
      dead = error?.code === 'ENOTFOUND';
      return dead;
    }
    if (isPrivateAddress(address)) return false;

    const probe = async (method: 'HEAD' | 'GET') =>
      (await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; coachartie-linkcheck)' } })).status;
    let status = await probe('HEAD');
    // Some servers answer HEAD wrongly; only a GET's 404 counts.
    if (status === 404 || status === 405 || status === 410) status = await probe('GET');
    dead = status === 404 || status === 410;
  } catch {
    dead = false; // timeouts, TLS trouble, bad URL syntax: not proof of anything
  } finally {
    cache.set(url, { at: Date.now(), dead });
  }
  return dead;
}

/** Remove dead links from a reply. Markdown links keep their text; bare URLs become a note. */
export async function stripDeadLinks(text: string): Promise<{ text: string; removed: string[] }> {
  const found = [...new Set(text.match(URL_RE) ?? [])].slice(0, MAX_LINKS);
  if (!found.length) return { text, removed: [] };
  const verdicts = await Promise.all(found.map(async (u) => [u, await isDeadLink(u)] as const));
  const removed = verdicts.filter(([, dead]) => dead).map(([u]) => u);
  let out = text;
  for (const url of removed) {
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\[([^\\]]+)\\]\\(<?${esc}>?\\)`, 'g'), '$1')
      .replace(new RegExp(`<?${esc}>?`, 'g'), DEAD_LINK_NOTE);
  }
  if (removed.length) logger.warn(`🔗 Removed dead link(s) from a reply: ${removed.join(', ')}`);
  return { text: out, removed };
}

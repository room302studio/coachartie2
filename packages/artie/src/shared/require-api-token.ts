import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

// Callers on this box (other Artie services, ~/scripts) hit 127.0.0.1 directly.
// Everything else — Caddy, cloudflared, docker bridges, the tailnet via a proxy —
// must present the shared token. Proxies arrive on loopback too, but they always
// add forwarding headers, so 'loopback with no forwarding headers' is the only
// unauthenticated path. Do not set `trust proxy` / use req.ip here: those honor
// X-Forwarded-For, which a remote caller controls.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray'];

function isDirectLocal(req: Request): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress || '')) return false;
  return !FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Require `Authorization: Bearer $DM_API_TOKEN` unless the request is direct-local or matches `open`. */
export function requireApiToken(open: Array<(req: Request) => boolean> = []) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isDirectLocal(req) || open.some((f) => f(req))) return next();
    const expected = process.env.DM_API_TOKEN || process.env.ARTIE_API_TOKEN;
    // Fail closed: no configured token means no remote access at all.
    if (expected && tokenMatches(req.headers.authorization, expected)) return next();
    res.status(401).json({ success: false, error: 'Unauthorized — Bearer token required' });
  };
}

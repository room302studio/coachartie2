/**
 * Wave 10: the ledger's one-liners in one home each (shared/text.ts, shared/email.ts,
 * shared/mentions.ts), plus parseLogLine, the temporal keyword list and diagnose's \b rows.
 * Each "old" expression below is the regex the call sites used before, quoted verbatim.
 */
import { describe, it, expect } from 'vitest';
import { collapseWhitespace, slugify, trimTrailingSlash, sanitizeIdentifier } from '../../src/shared/text.js';
import { isEmail } from '../../src/shared/email.js';
import { replaceMention } from '../../src/shared/mentions.js';
import { parseLogLine } from '../../src/engine/routes/logs.js';
import { extractTemporalKeywords } from '../../src/engine/memory/recall.js';
import { analyzeError } from '../../src/engine/tools/ops/diagnose.js';

const SAMPLES = ['  Hello   World\n\tagain ', 'jonah_AB!!', '--Room 302 Studio--', '#🤖robot', '', 'a/b\\c d.e'];

describe('shared/text.ts matches the copies it replaced', () => {
  it('collapseWhitespace', () => {
    for (const s of SAMPLES) expect(collapseWhitespace(s)).toBe(s.replace(/\s+/g, ' '));
  });

  it("slugify '-' (channel-digest) and '_' (stream-reply, metro analyze)", () => {
    for (const s of SAMPLES) {
      expect(slugify(s)).toBe(s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      expect(slugify(s, '_')).toBe(s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    }
  });

  it('trimTrailingSlash', () => {
    for (const s of ['https://openrouter.ai/api/v1', 'https://x/v1/', 'https://x/v1///', '']) {
      expect(trimTrailingSlash(s)).toBe(s.replace(/\/+$/, ''));
    }
  });

  it('sanitizeIdentifier (pending-attachments; user-profile after lowercasing)', () => {
    for (const s of [...SAMPLES, '123456789012345678', 'Blue.Sky']) {
      expect(sanitizeIdentifier(s)).toBe(s.replace(/[^a-zA-Z0-9-_]/g, '_'));
      expect(sanitizeIdentifier(s.toLowerCase())).toBe(s.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
    }
  });
});

describe('isEmail (zod) for the four email checks', () => {
  it('accepts ordinary addresses, rejects the obvious non-addresses', () => {
    for (const ok of ['user@example.com', 'first.last+tag@sub.example.co.uk', 'artie@coachartiebot.com']) {
      expect(isEmail(ok)).toBe(true);
    }
    for (const bad of ['', 'user', 'user@', '@example.com', 'user@example', 'two words@example.com', '<@123>', 42, null]) {
      expect(isEmail(bad)).toBe(false);
    }
  });
});

describe('replaceMention', () => {
  it('replaces both mention forms, every occurrence, and nothing else', () => {
    expect(replaceMention('<@123> hi <@!123> and <@456>', '123', '')).toBe(' hi  and <@456>');
    expect(replaceMention('ask <@!456>', '456', '@jonah')).toBe('ask @jonah');
    expect(replaceMention('<@1234>', '123', 'x')).toBe('<@1234>');
  });

  it('a replacement is literal (no $& expansion), and a missing or non-numeric id is a no-op', () => {
    expect(replaceMention('<@1>', '1', '@$&$1')).toBe('@$&$1');
    expect(replaceMention('<@1>', undefined, '')).toBe('<@1>');
    expect(replaceMention('<@.*>', '.*', '')).toBe('<@.*>');
  });
});

describe('routes/logs.ts parseLogLine', () => {
  it('reads "HH:MM:SS level: message", else an info line stamped now', () => {
    expect(parseLogLine('12:34:56 warn: disk almost full')).toEqual({
      timestamp: '12:34:56',
      level: 'warn',
      message: 'disk almost full',
    });
    const other = parseLogLine('free text');
    expect(other.level).toBe('info');
    expect(other.message).toBe('free text');
    expect(Number.isNaN(Date.parse(other.timestamp))).toBe(false);
  });
});

describe('recall temporal keywords: one list, same words as the six regexes', () => {
  const OLD = [
    /\b(today|yesterday|tomorrow|now|recently|lately|earlier|later)\b/gi,
    /\b(morning|afternoon|evening|night|dawn|dusk)\b/gi,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(weekend|weekday|week|month|year)\b/gi,
    /\b(spring|summer|fall|autumn|winter|holiday|birthday)\b/gi,
    /\b(always|usually|often|sometimes|rarely|never|before|after|during|since)\b/gi,
  ];
  const old = (m: string) => [...new Set(OLD.flatMap((re) => (m.match(re) || []).map((w) => w.toLowerCase())))];

  it('finds the same set', () => {
    for (const m of [
      'What did I say YESTERDAY morning about the weekend?',
      'weekends and weekdays, every week since spring',
      'Nowhere near the nightly build',
      'no time words here',
      'Before Monday, after Friday, during the holiday: always later',
    ]) {
      expect(new Set(extractTemporalKeywords(m))).toEqual(new Set(old(m)));
    }
  });
});

describe('diagnose: bare status codes need word boundaries', () => {
  it('matches a status, not a longer number', () => {
    expect(analyzeError('Request failed with status code 404').causes).toContain('Resource not found');
    expect(analyzeError('listening on port 4010').causes).not.toContain('Authentication failed');
    expect(analyzeError('order 15003 shipped').causes).not.toContain('Server-side error');
    expect(analyzeError('HTTP 403').causes).toContain('Access forbidden');
  });
});

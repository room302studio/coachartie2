/**
 * Summarize the Jev shadow JSONL (JEV_SHADOW_LOG) per experiment.
 *
 *   npx tsx scripts/jev-shadow-report.ts [path/to/jev-shadow.jsonl]   (default: $JEV_SHADOW_LOG)
 *
 * Per experiment (and per question for multi-question experiments, as `experiment/question`):
 * n, agreement %, micro-fallback rate and how often Jev was confident (p ≥ 0.8, or ≤ 0.2 for
 * yes/no) when micro fell back, mean/p95 latency each side, error rate, and the 10
 * most-confident disagreements. "micro" is whatever answers today (micro LLM, Gemini judge,
 * the Steam reviewer's thumbs).
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Part {
  micro?: string | boolean;
  microFallback?: boolean;
  microMs?: number;
  jev?: string | boolean | number;
  jevType?: 'noul' | 'choice' | 'score';
  jevProbability?: number;
  jevConfidence?: number;
  agree?: boolean;
}

export interface ShadowLine extends Part {
  t?: number;
  experiment?: string;
  helper?: string;
  text?: string;
  question?: string;
  jevMs?: number;
  parts?: Record<string, Part>;
  error?: string;
}

interface Row extends Part {
  text?: string;
  jevMs?: number;
  error?: string;
}

export interface Disagreement {
  micro: Part['micro'];
  jev: Part['jev'];
  certainty: number;
  text: string;
}

export interface ExperimentStats {
  experiment: string;
  n: number;
  compared: number;
  agreement: number | null;
  fallbackRate: number | null;
  jevConfidentOnFallback: number | null;
  microMs: { mean: number; p95: number } | null;
  jevMs: { mean: number; p95: number } | null;
  errorRate: number;
  disagreements: Disagreement[];
}

export function parseLines(raw: string): ShadowLine[] {
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ShadowLine];
      } catch {
        return [];
      }
    });
}

const typeOf = (r: Part & { helper?: string }): Part['jevType'] =>
  r.jevType ?? (r.helper === 'pickOne' ? 'choice' : r.helper === 'askYesNo' ? 'noul' : undefined);

/** How sure Jev was of its own answer, 0.5–1 for yes/no, P(choice) for a choice. */
function certainty(r: Part): number | undefined {
  const p = r.jevProbability;
  if (typeof p !== 'number') return r.jevConfidence;
  return r.jevType === 'choice' ? p : Math.max(p, 1 - p);
}

const confident = (r: Part) => {
  const c = certainty(r);
  return typeof c === 'number' && c >= 0.8;
};

function latency(xs: number[]) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ratio = (num: number, den: number) => (den === 0 ? null : num / den);

/** Flatten lines into rows keyed by experiment, plus `experiment/question` rows for parts. */
function group(lines: ShadowLine[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  const push = (key: string, row: Row) => groups.set(key, [...(groups.get(key) || []), row]);
  for (const l of lines) {
    const exp = l.experiment || l.helper || 'unknown';
    push(exp, { ...l, jevType: typeOf(l) });
    for (const [id, part] of Object.entries(l.parts || {})) {
      push(`${exp}/${id}`, { ...part, text: l.text, jevMs: l.jevMs, error: l.error });
    }
  }
  return groups;
}

export function summarize(lines: ShadowLine[]): ExperimentStats[] {
  return [...group(lines).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([experiment, rows]) => {
      const ok = rows.filter((r) => !r.error);
      const compared = ok.filter((r) => typeof r.agree === 'boolean');
      const withFallback = rows.filter((r) => typeof r.microFallback === 'boolean');
      const fellBack = ok.filter((r) => r.microFallback === true);
      return {
        experiment,
        n: rows.length,
        compared: compared.length,
        agreement: ratio(compared.filter((r) => r.agree).length, compared.length),
        fallbackRate: ratio(withFallback.filter((r) => r.microFallback).length, withFallback.length),
        jevConfidentOnFallback: ratio(fellBack.filter(confident).length, fellBack.length),
        microMs: latency(rows.flatMap((r) => (typeof r.microMs === 'number' ? [r.microMs] : []))),
        jevMs: latency(ok.flatMap((r) => (typeof r.jevMs === 'number' ? [r.jevMs] : []))),
        errorRate: rows.length ? rows.filter((r) => r.error).length / rows.length : 0,
        disagreements: compared
          .filter((r) => !r.agree)
          .map((r) => ({ micro: r.micro, jev: r.jev, certainty: certainty(r) ?? 0, text: clip(r.text || '') }))
          .sort((a, b) => b.certainty - a.certainty)
          .slice(0, 10),
      };
    });
}

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const ms = (x: { mean: number; p95: number } | null) => (x ? `${x.mean}/${x.p95}ms` : '-');

export function formatReport(stats: ExperimentStats[]): string {
  const out: string[] = [];
  for (const s of stats) {
    out.push(
      `## ${s.experiment}`,
      `n=${s.n}  compared=${s.compared}  agreement=${pct(s.agreement)}  errors=${pct(s.errorRate)}`,
      `micro fallback=${pct(s.fallbackRate)}  jev confident when micro fell back=${pct(s.jevConfidentOnFallback)}`,
      `latency mean/p95  micro=${ms(s.microMs)}  jev=${ms(s.jevMs)}`
    );
    if (s.disagreements.length) {
      out.push('most-confident disagreements:');
      for (const d of s.disagreements) {
        out.push(`  ${d.certainty.toFixed(2)}  micro=${String(d.micro)} jev=${String(d.jev)}  ${d.text}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || process.env.JEV_SHADOW_LOG;
  if (!file) {
    console.error('usage: npx tsx scripts/jev-shadow-report.ts <jev-shadow.jsonl>  (or set JEV_SHADOW_LOG)');
    process.exit(1);
  }
  console.log(formatReport(summarize(parseLines(readFileSync(file, 'utf8')))));
}

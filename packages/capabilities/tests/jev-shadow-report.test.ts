import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLines, summarize, formatReport } from '../../../scripts/jev-shadow-report.ts';

const fixture = readFileSync(join(__dirname, 'fixtures', 'jev-shadow.jsonl'), 'utf8');

describe('jev shadow report', () => {
  const stats = summarize(parseLines(fixture));
  const get = (name: string) => stats.find((s) => s.experiment === name)!;

  it('skips malformed lines and groups by experiment, helper and part', () => {
    expect(stats.map((s) => s.experiment)).toEqual([
      'pickOne',
      'preflight-batch',
      'preflight-batch/format',
      'preflight-batch/tone',
      'quiz-judge',
    ]);
  });

  it('computes agreement, fallback, confidence-on-fallback, errors and latency', () => {
    const q = get('quiz-judge');
    expect(q.n).toBe(4);
    expect(q.compared).toBe(2);
    expect(q.agreement).toBe(0.5);
    expect(q.fallbackRate).toBe(0.25);
    expect(q.jevConfidentOnFallback).toBe(1);
    expect(q.errorRate).toBe(0.25);
    expect(q.microMs).toEqual({ mean: 118, p95: 200 });
    expect(q.jevMs).toEqual({ mean: 400, p95: 500 });
  });

  it('lists the most-confident disagreements first', () => {
    const q = get('quiz-judge');
    expect(q.disagreements).toHaveLength(1);
    expect(q.disagreements[0]).toMatchObject({ micro: true, jev: false });
    expect(q.disagreements[0].certainty).toBeCloseTo(0.95);
    expect(get('preflight-batch/tone').agreement).toBe(1);
    expect(get('preflight-batch/format').disagreements[0].certainty).toBe(0.6);
    expect(get('pickOne').disagreements[0].certainty).toBe(0.7);
  });

  it('formats a readable report', () => {
    const out = formatReport(stats);
    expect(out).toContain('## quiz-judge');
    expect(out).toContain('agreement=50.0%');
    expect(out).toContain('micro=true jev=false');
  });
});

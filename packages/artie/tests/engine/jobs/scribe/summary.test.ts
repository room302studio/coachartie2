import { describe, it, expect } from 'vitest';
import {
  buildTranscriptBlock,
  buildSummaryPrompt,
  parseScribeSummaryResponse,
} from '../../../../src/engine/jobs/scribe/summary.js';
import type { ScribeUtterance } from '../../../../src/shared/db/scribe-store.js';

function utterance(overrides: Partial<ScribeUtterance> = {}): ScribeUtterance {
  return {
    id: 1,
    sessionId: 's1',
    speakerId: 'u1',
    displayName: 'EJ',
    text: 'hello',
    ts: '2026-10-26T10:00:00.000Z',
    durationSeconds: 1,
    ...overrides,
  };
}

describe('buildTranscriptBlock', () => {
  it('formats one line per utterance as [ts] name: text', () => {
    const block = buildTranscriptBlock([utterance({ text: 'first' }), utterance({ displayName: 'Dev', text: 'second' })]);
    expect(block).toContain('EJ: first');
    expect(block).toContain('Dev: second');
  });
});

describe('buildSummaryPrompt', () => {
  it('names the default repo in the instructions', () => {
    const prompt = buildSummaryPrompt({ defaultRepo: 'room302studio/coachartie2', transcript: 'EJ: hi' });
    expect(prompt).toContain('room302studio/coachartie2');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"proposals"');
  });
});

describe('parseScribeSummaryResponse: tolerates junk', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      summary: 'Decisions: shipped it.',
      proposals: [{ kind: 'create', repo: 'owner/repo', title: 'Bug', body: 'Fix the thing' }],
    });
    const result = parseScribeSummaryResponse(raw);
    expect(result.summaryText).toBe('Decisions: shipped it.');
    expect(result.proposals).toHaveLength(1);
  });

  it('falls back to raw text, empty proposals, when the reply is not JSON at all', () => {
    const result = parseScribeSummaryResponse('the model just chatted instead of returning JSON');
    expect(result.summaryText).toContain('the model just chatted');
    expect(result.proposals).toEqual([]);
  });

  it('drops malformed proposal entries instead of throwing', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      proposals: [
        { kind: 'create', repo: 'owner/repo', title: 'Good one', body: 'fine' },
        { kind: 'update', repo: 'owner/repo', title: 'Missing issue number', body: 'no issueNumber field' },
        { kind: 'bogus', repo: 'owner/repo', title: 'Bad kind', body: 'x' },
        { repo: 'owner/repo' }, // missing everything
        'not even an object',
        null,
      ],
    });
    const result = parseScribeSummaryResponse(raw);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].title).toBe('Good one');
  });

  it('handles proposals missing entirely, or not an array', () => {
    expect(parseScribeSummaryResponse(JSON.stringify({ summary: 'ok' })).proposals).toEqual([]);
    expect(parseScribeSummaryResponse(JSON.stringify({ summary: 'ok', proposals: 'nope' })).proposals).toEqual([]);
  });

  it('handles a response that is JSON but not an object (array)', () => {
    const result = parseScribeSummaryResponse('[1,2,3]');
    expect(result.proposals).toEqual([]);
    expect(result.summaryText.length).toBeGreaterThan(0);
  });

  it('requires an issueNumber for update proposals specifically', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      proposals: [{ kind: 'update', repo: 'owner/repo', issueNumber: 42, title: 't', body: 'b' }],
    });
    const result = parseScribeSummaryResponse(raw);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].issueNumber).toBe(42);
  });
});

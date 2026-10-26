import { describe, it, expect } from 'vitest';
import { scribeSttModel, sttPerMinuteUsd, computeSttCostUsd } from '../../../../src/engine/jobs/scribe/cost.js';

describe('scribeSttModel', () => {
  it('defaults to the cheapest Groq Whisper tier on OpenRouter', () => {
    expect(scribeSttModel({})).toBe('openai/whisper-large-v3-turbo');
  });

  it('is overridable by SCRIBE_STT_MODEL', () => {
    expect(scribeSttModel({ SCRIBE_STT_MODEL: 'openai/whisper-large-v3' })).toBe('openai/whisper-large-v3');
  });
});

describe('sttPerMinuteUsd / computeSttCostUsd', () => {
  it('prices the default model at ~$0.00066/min', () => {
    expect(sttPerMinuteUsd('openai/whisper-large-v3-turbo')).toBeCloseTo(0.00066, 6);
  });

  it('bills an unrecognized model at the safe-high default rather than free', () => {
    expect(sttPerMinuteUsd('some/unknown-model')).toBeGreaterThan(0);
  });

  it('computes cost proportional to duration', () => {
    const perMinute = sttPerMinuteUsd('openai/whisper-large-v3-turbo');
    expect(computeSttCostUsd(60, 'openai/whisper-large-v3-turbo')).toBeCloseTo(perMinute, 8);
    expect(computeSttCostUsd(30, 'openai/whisper-large-v3-turbo')).toBeCloseTo(perMinute / 2, 8);
    expect(computeSttCostUsd(0, 'openai/whisper-large-v3-turbo')).toBe(0);
  });
});

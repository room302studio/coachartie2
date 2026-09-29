import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ObservationalLearning,
  isObservationalLearningEnabled,
  observationMinMessages,
  isNonEventSummary,
} from '../src/services/observational-learning.js';

describe('observation firehose flag (#91)', () => {
  const saved = process.env.OBSERVATIONAL_LEARNING_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.OBSERVATIONAL_LEARNING_ENABLED;
    else process.env.OBSERVATIONAL_LEARNING_ENABLED = saved;
    vi.restoreAllMocks();
  });

  it('is off unless explicitly enabled', () => {
    expect(isObservationalLearningEnabled({})).toBe(false);
    expect(isObservationalLearningEnabled({ OBSERVATIONAL_LEARNING_ENABLED: 'false' })).toBe(false);
    expect(isObservationalLearningEnabled({ OBSERVATIONAL_LEARNING_ENABLED: 'true' })).toBe(true);
  });

  it('when off, initialize() schedules nothing (no summaries, no profile synthesis)', () => {
    delete process.env.OBSERVATIONAL_LEARNING_ENABLED;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    ObservationalLearning.getInstance().initialize({} as never);
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    ObservationalLearning.getInstance().shutdown();
  });

  it('floors batches at 5 human messages by default', () => {
    expect(observationMinMessages({})).toBe(5);
    expect(observationMinMessages({ OBSERVATION_MIN_MESSAGES: '8' })).toBe(8);
    expect(observationMinMessages({ OBSERVATION_MIN_MESSAGES: 'nope' })).toBe(5);
  });
});

describe('isNonEventSummary', () => {
  it('rejects summaries that record nothing happened', () => {
    expect(
      isNonEventSummary(
        'In the previous dialogue between Coach Artie and the user, no specific background details or user tendencies were mentioned. No correlations…'
      )
    ).toBe(true);
    expect(isNonEventSummary('Nothing notable was discussed in this brief exchange.')).toBe(true);
    expect(isNonEventSummary('')).toBe(true);
  });

  it('keeps summaries with substance', () => {
    expect(
      isNonEventSummary(
        'Players keep hitting the same crash when importing NZ maps; two asked whether a hotfix is planned this week.'
      )
    ).toBe(false);
  });
});

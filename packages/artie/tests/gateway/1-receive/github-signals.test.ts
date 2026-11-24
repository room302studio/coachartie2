import { describe, it, expect } from 'vitest';
import { looksLikeGithubActivity } from '../../../src/gateway/1-receive/github-signals.js';

// Wave 7 / ledger #3: whole-word GitHub-activity signals.
describe('looksLikeGithubActivity', () => {
  const no = [
    'that is a problem',
    'pass me a tissue',
    'the committee meets tuesday',
    'emerge from the tunnel',
    'pushover',
    'improve the depression',
    'branching out', // not an inflection we list
  ];
  for (const text of no) {
    it(`ignores ${JSON.stringify(text)}`, () => {
      expect(looksLikeGithubActivity(text)).toBe(false);
    });
  }

  const yes = [
    'opened a PR',
    'pushed a commit',
    'just merged the fix',
    'I opened #12',
    'filed two issues today',
    'my PRs are stuck',
    'check the github repo',
    'rebased my branch',
    'i filed a bug',
  ];
  for (const text of yes) {
    it(`matches ${JSON.stringify(text)}`, () => {
      expect(looksLikeGithubActivity(text)).toBe(true);
    });
  }
});

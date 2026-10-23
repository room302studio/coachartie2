import { describe, it, expect } from 'vitest';
import { substituteKeys } from '../../src/engine/5-tool-loop/execute.js';

// Wave 7 / ledger #11: {{key}} substitution treats the key and the value literally.
describe('substituteKeys', () => {
  it('a key containing . substitutes only itself', () => {
    const subs = new Map([['a.b', 'X']]);
    expect(substituteKeys('{{a.b}} {{ a.b }} {{aZb}}', subs)).toBe('X X {{aZb}}');
  });

  it('a key containing * is literal, not a quantifier', () => {
    const subs = new Map([['n*', 'Y']]);
    expect(substituteKeys('{{n*}} {{nnn}} {{}}', subs)).toBe('Y {{nnn}} {{}}');
  });

  it('values with $& or $1 are inserted verbatim', () => {
    const subs = new Map([['result', 'costs $& and $1']]);
    expect(substituteKeys('got: {{result}}', subs)).toBe('got: costs $& and $1');
  });

  it('the real keys still work', () => {
    const subs = new Map([
      ['result', 'r'],
      ['result_1', 'r1'],
      ['memories', 'm'],
    ]);
    expect(substituteKeys('{{result}}/{{result_1}}/{{ memories }}', subs)).toBe('r/r1/m');
  });
});

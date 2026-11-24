import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  parseArtieCustomId,
  checkClickCap,
  recordClick,
  resetClickCountersForTests,
  buildClickTurnText,
  clickRefusal,
  formModalId,
  buttonIdOfForm,
  buildFormModal,
  buildFormTurnText,
} from '../../src/gateway/1-receive/on-component-click.js';

describe('parseArtieCustomId', () => {
  it('parses artie:<turn>:<index>', () => {
    expect(parseArtieCustomId('artie:abc123:0')).toEqual({ turnId: 'abc123', index: 0 });
    expect(parseArtieCustomId('artie:abc123:4')).toEqual({ turnId: 'abc123', index: 4 });
  });

  it('rejects anything else — including other capabilities\' custom ids', () => {
    expect(parseArtieCustomId('btn_0')).toBeNull();
    expect(parseArtieCustomId('ask_123_yes')).toBeNull();
    expect(parseArtieCustomId('daily:guess:2026-10-26')).toBeNull();
    expect(parseArtieCustomId('artie:abc')).toBeNull(); // missing index
    expect(parseArtieCustomId('artie:abc:x')).toBeNull(); // non-numeric index
  });
});

describe('component click caps', () => {
  beforeEach(() => {
    resetClickCountersForTests();
  });

  it('allows the first click from each of several distinct users', () => {
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: true });
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-1', 'user-b')).toEqual({ allowed: true });
  });

  it('blocks a second click from the SAME user on the SAME message (duplicate)', () => {
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: true });
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-1', 'user-a')).toEqual({ allowed: false, reason: 'duplicate' });
  });

  it('the same user clicking a DIFFERENT message is not a duplicate', () => {
    recordClick('msg-1', 'user-a');
    expect(checkClickCap('msg-2', 'user-a')).toEqual({ allowed: true });
  });

  it('blocks the 9th distinct-user click on one message (default cap 8)', () => {
    for (let i = 0; i < 8; i++) {
      const userId = `user-${i}`;
      expect(checkClickCap('msg-cap', userId)).toEqual({ allowed: true });
      recordClick('msg-cap', userId);
    }
    expect(checkClickCap('msg-cap', 'user-9')).toEqual({ allowed: false, reason: 'cap' });
  });

  it('honors ARTIE_BUTTON_CLICK_CAP when set', () => {
    const prev = process.env.ARTIE_BUTTON_CLICK_CAP;
    process.env.ARTIE_BUTTON_CLICK_CAP = '2';
    try {
      expect(checkClickCap('msg-env', 'u1')).toEqual({ allowed: true });
      recordClick('msg-env', 'u1');
      expect(checkClickCap('msg-env', 'u2')).toEqual({ allowed: true });
      recordClick('msg-env', 'u2');
      expect(checkClickCap('msg-env', 'u3')).toEqual({ allowed: false, reason: 'cap' });
    } finally {
      if (prev === undefined) delete process.env.ARTIE_BUTTON_CLICK_CAP;
      else process.env.ARTIE_BUTTON_CLICK_CAP = prev;
    }
  });

  it('checkClickCap alone (without recordClick) does not consume the cap', () => {
    expect(checkClickCap('msg-peek', 'user-a')).toEqual({ allowed: true });
    expect(checkClickCap('msg-peek', 'user-a')).toEqual({ allowed: true }); // still allowed, never recorded
  });
});

describe('clickRefusal', () => {
  it('proceeds (null) when brownout is normal and the click is allowed', () => {
    expect(clickRefusal('normal', { allowed: true })).toBeNull();
  });

  it('proceeds (null) when brownout is lean and the click is allowed — lean only tapers reply length, not clicks', () => {
    expect(clickRefusal('lean', { allowed: true })).toBeNull();
  });

  it('refuses every click under critical brownout, even with cap room (brownout wins over the cap)', () => {
    expect(clickRefusal('critical', { allowed: true })).toBe('Running lean right now — @ me instead.');
  });

  it('a duplicate click is refused under normal brownout', () => {
    expect(clickRefusal('normal', { allowed: false, reason: 'duplicate' })).toBe(
      'Already got your pick on this one.'
    );
  });

  it('a capped-out message is refused under normal brownout', () => {
    expect(clickRefusal('normal', { allowed: false, reason: 'cap' })).toBe(
      "That one's closed out — too many clicks already."
    );
  });

  it('critical brownout text wins even when the check itself would also refuse', () => {
    // Same ephemeral either way is fine, but brownout's text is what actually sends —
    // confirms the precedence, not just two independently-correct branches.
    expect(clickRefusal('critical', { allowed: false, reason: 'cap' })).toBe(
      'Running lean right now — @ me instead.'
    );
  });
});

describe('buildClickTurnText', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats "[button] <name> picked "<label>" on your message "<snippet>" (<n>s after you posted)"', () => {
    vi.useFakeTimers();
    const postedAt = 0;
    vi.setSystemTime(12_000);
    const text = buildClickTurnText('ejfox', 'Yes', 'Should I deploy?', postedAt);
    expect(text).toBe('[button] ejfox picked "Yes" on your message "Should I deploy?" (12s after you posted)');
  });

  it('truncates the original message to 80 chars', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const longMessage = 'x'.repeat(200);
    const text = buildClickTurnText('ejfox', 'Yes', longMessage, 0);
    const snippet = text.match(/on your message "(.*)" \(/)?.[1];
    expect(snippet?.length).toBe(80);
  });

  it('never reports negative elapsed time (clock skew clamps to 0)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const text = buildClickTurnText('ejfox', 'Yes', 'msg', 5000); // "posted" in the future
    expect(text).toContain('(0s after you posted)');
  });
});

describe('forms behind buttons (2026-11-24)', () => {
  it('a form modal id maps back to exactly its button', () => {
    const modalId = formModalId('artie:abc123:7');
    expect(modalId).toBe('artie-form:abc123:7');
    expect(buttonIdOfForm(modalId)).toBe('artie:abc123:7');
    expect(buttonIdOfForm('daily:modal:2026-11-24')).toBeNull();
  });

  it('builds a modal with one input per field, paragraphs where asked', () => {
    const modal = buildFormModal('artie:abc123:0', {
      title: 'Report a bug',
      fields: [{ label: 'What happened?' }, { label: 'Steps', paragraph: true, required: false }],
    }).toJSON();
    expect(modal.custom_id).toBe('artie-form:abc123:0');
    expect(modal.title).toBe('Report a bug');
    const inputs = modal.components.map((row: any) => row.components[0]);
    expect(inputs.map((i: any) => i.custom_id)).toEqual(['f0', 'f1']);
    expect(inputs[1].style).toBe(2);
    expect(inputs[1].required).toBe(false);
    expect(inputs[0].max_length).toBe(1000);
  });

  it('tells Artie who filled in what', () => {
    const text = buildFormTurnText('fan', 'Report a bug', [{ label: 'What happened?', value: 'trains vanish' }, { label: 'Steps', value: '' }], 'Found a bug?');
    expect(text).toContain('[form] fan filled in "Report a bug" on your message "Found a bug?"');
    expect(text).toContain('- What happened?: trains vanish');
    expect(text).toContain('- Steps: (left blank)');
  });
});

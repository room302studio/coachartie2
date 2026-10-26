import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PIN (wave 5): how a finished (or streaming) reply's control tokens are handled TODAY, driven
// black-box through processUserIntent with the engine client and job watcher mocked out.
// Written before stream-reply.ts was split into control-tokens/output-safety/threads, so the
// split must keep every row green without editing it. Covers [SILENT], [TIMEOUT], [TIMEOUT:NN]
// and the casino tokens ([GAMBLE…], [WHEEL…], [DEAL], [HIT], [STAND], [SLOTS…]), with the
// casino both closed and open. Verdict prose is pinned by its load-bearing fragments (roll,
// stake, odds, payout); stakes, clamps, call order and what reaches the channel are exact.

const h = vi.hoisted(() => {
  const state = {
    casinoOpen: false,
    handlers: null as null | {
      onProgress: (s: any) => Promise<void>;
      onComplete: (r: string) => Promise<void>;
    },
  };
  return { state };
});

vi.mock('../../src/gateway/3-ask-engine/engine-client.js', () => ({
  capabilitiesClient: {
    submitJob: vi.fn(async () => ({ messageId: 'job-0000-12345678' })),
    linkDiscordMessage: vi.fn(async () => {}),
    getPendingAttachments: vi.fn(async () => []),
  },
}));
vi.mock('../../src/gateway/3-ask-engine/job-watcher.js', () => ({
  jobMonitor: {
    monitorJob: vi.fn((_id: string, handlers: any) => {
      h.state.handlers = handlers;
    }),
  },
}));
vi.mock('../../src/gateway/telemetry.js', () => ({
  telemetry: new Proxy({}, { get: () => () => {} }),
}));
vi.mock('../../src/gateway/games/casino.js', () => ({
  get CASINO_OPEN() {
    return h.state.casinoOpen;
  },
  recordSelfSpin: vi.fn(() => ({ cred: 160, streak: 1, served: 0 })),
  adjustCred: vi.fn(() => ({ cred: 150 })),
  recordTableServed: vi.fn(() => ({ served: 60 })),
  bjDeal: vi.fn(),
  bjHit: vi.fn(),
  bjStand: vi.fn(),
  bjFmt: (cards: string[]) => cards.join(''),
  spinSlots: vi.fn(),
  bumpHouseEvents: vi.fn(),
  houseFlourish: () => '',
}));

import { processUserIntent } from '../../src/gateway/4-reply/stream-reply.js';
import * as casino from '../../src/gateway/games/casino.js';

const mocked = casino as unknown as Record<string, ReturnType<typeof vi.fn>>;

interface Fake {
  sent: string[];
  timeouts: Array<[number, string]>;
  wheels: Array<[number, string | undefined]>;
  intent: any;
}

function fakeIntent(opts: { noTimeout?: boolean; noWheel?: boolean; landed?: boolean } = {}): Fake {
  const f: Fake = { sent: [], timeouts: [], wheels: [], intent: null };

  let timeoutPart: Record<string, unknown> = {};
  if (!opts.noTimeout) {
    timeoutPart = {
      timeoutAuthor: vi.fn(async (s: number, r: string) => {
        f.timeouts.push([s, r]);
        return opts.landed ?? true;
      }),
    };
  }

  let wheelPart: Record<string, unknown> = {};
  if (!opts.noWheel) {
    wheelPart = {
      spinChannelWheel: vi.fn(async (s: number, name?: string) => {
        f.wheels.push([s, name]);
        return { target: 'Vic', roll: 77, boxed: true, landed: true, stake: s };
      }),
    };
  }

  f.intent = {
    content: 'hi artie',
    userId: 'u1',
    username: 'gambler1',
    source: 'message',
    context: { channelId: 'c1' },
    respond: vi.fn(async (c: string) => {
      f.sent.push(c);
    }),
    editResponse: vi.fn(async (c: string) => {
      f.sent.push(`EDIT:${c}`);
    }),
    deleteResponse: vi.fn(async () => {}),
    ...timeoutPart,
    ...wheelPart,
  };
  return f;
}

async function complete(raw: string, f: Fake = fakeIntent()): Promise<Fake> {
  h.state.handlers = null;
  await processUserIntent(f.intent, { enableTyping: false, enableStreaming: false });
  expect(h.state.handlers).not.toBeNull();
  await h.state.handlers!.onComplete(raw);
  return f;
}

function expectedSent(reply: string | null): string[] {
  if (reply === null) {
    return [];
  }
  return [reply];
}

beforeEach(() => {
  h.state.casinoOpen = false;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks(); // vitest >=3: restores vi.spyOn spies (Math.random) only
  vi.useRealTimers();
});

describe('[SILENT] and [TIMEOUT] on the final reply (casino closed)', () => {
  // [raw, what reaches respond() (null = nothing posted), timeouts fired]
  const ROWS: Array<[string, string | null, Array<[number, string]>]> = [
    ['hello there', 'hello there', []],
    ['[SILENT]', null, []],
    ['  [SILENT] nah, not worth it', null, []],
    ['[silent]', null, []],
    ['ok [SILENT] fine', 'ok  fine', []],
    ['calm down [TIMEOUT]', 'calm down', [[30, 'Coach Artie warden discipline']]],
    ['out [TIMEOUT:120]', 'out', [[120, 'Coach Artie warden discipline']]],
    ['[timeout:45] shh', 'shh', [[45, 'Coach Artie warden discipline']]],
    ['[TIMEOUT:0] bye', 'bye', [[30, 'Coach Artie warden discipline']]],
    ['[TIMEOUT:2] bye', 'bye', [[5, 'Coach Artie warden discipline']]],
    ['[TIMEOUT:999] bye', 'bye', [[300, 'Coach Artie warden discipline']]],
    // four digits is not a marker at all: nothing fires and the text stays
    ['[TIMEOUT:5000] bye', '[TIMEOUT:5000] bye', []],
    ['[TIMEOUT:60] x [TIMEOUT:30]', 'x', [[60, 'Coach Artie warden discipline']]],
    // the timeout still lands even though the reply itself is suppressed
    ['[SILENT] [TIMEOUT:60]', null, [[60, 'Coach Artie warden discipline']]],
    ['[TIMEOUT]', null, [[30, 'Coach Artie warden discipline']]],
    ['', null, []],
  ];
  for (const [raw, reply, timeouts] of ROWS) {
    it(JSON.stringify(raw), async () => {
      const f = await complete(raw);
      expect(f.sent).toEqual(expectedSent(reply));
      expect(f.timeouts).toEqual(timeouts);
    });
  }

  it('without a timeoutAuthor hook the [TIMEOUT] marker is left in place', async () => {
    const f = await complete('stop [TIMEOUT:60]', fakeIntent({ noTimeout: true }));
    expect(f.sent).toEqual(['stop [TIMEOUT:60]']);
  });

  it('capability tags are cleaned before the tokens are read', async () => {
    const f = await complete('<capability name="x"/>[SILENT]');
    expect(f.sent).toEqual([]);
  });
});

describe('casino tokens while the casino is CLOSED', () => {
  const ROWS: Array<[string, string | null]> = [
    ['spin it [GAMBLE:60:30]', 'spin it'],
    ['[GAMBLE]', null],
    ['[DEAL] [HIT] [STAND] [SLOTS:20] [WHEEL:30:bob] go', 'go'],
    ['[deal:40] cards?', 'cards?'],
  ];
  for (const [raw, reply] of ROWS) {
    it(JSON.stringify(raw), async () => {
      const f = await complete(raw);
      expect(f.sent).toEqual(expectedSent(reply));
      expect(f.timeouts).toEqual([]);
      expect(f.wheels).toEqual([]);
      expect(mocked.bumpHouseEvents).not.toHaveBeenCalled();
      expect(mocked.bjDeal).not.toHaveBeenCalled();
      expect(mocked.spinSlots).not.toHaveBeenCalled();
    });
  }
});

describe('casino tokens while the casino is OPEN', () => {
  beforeEach(() => {
    h.state.casinoOpen = true;
  });

  it('[GAMBLE] defaults: stake 60, odds 50; a winning roll pays and boxes nobody', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // roll 11
    const f = await complete('feeling lucky [GAMBLE]');
    expect(f.timeouts).toEqual([]);
    expect(mocked.recordSelfSpin).toHaveBeenCalledWith('u1', 'gambler1', true, 60, 0);
    expect(f.sent).toHaveLength(1);
    const [patter, verdict] = f.sent[0].split('\n\n');
    expect(patter).toBe('feeling lucky');
    expect(verdict).toContain('THE WHEEL');
    expect(verdict).toContain('roll 11/100, survive ≤50');
    expect(verdict).toContain('+60 cred');
  });

  it('[GAMBLE:90:20] losing roll boxes the gambler for the stake', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll 51
    const f = await complete('[GAMBLE:90:20]');
    expect(f.timeouts).toEqual([[90, 'Timeout roulette — rolled 51 vs 20, staked 90s']]);
    expect(mocked.recordSelfSpin).toHaveBeenCalledWith('u1', 'gambler1', false, 0, 90);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('THE BOX. 90s.');
    expect(f.sent[0].startsWith('🎰')).toBe(true);
  });

  it('[GAMBLE:500:5] clamps stake to 300 and odds to 10', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95); // roll 96
    const f = await complete('[GAMBLE:500:5]');
    expect(f.timeouts).toEqual([[300, 'Timeout roulette — rolled 96 vs 10, staked 300s']]);
  });

  it('[GAMBLE] whose timeout jams says so and records nothing', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // roll 100
    const f = await complete('[GAMBLE:30:50]', fakeIntent({ landed: false }));
    expect(f.timeouts).toEqual([[30, 'Timeout roulette — rolled 100 vs 50, staked 30s']]);
    expect(mocked.recordSelfSpin).not.toHaveBeenCalled();
    expect(f.sent[0]).toContain('mechanism jammed');
  });

  it('[GAMBLE] without a timeoutAuthor hook is left in place', async () => {
    const f = await complete('[GAMBLE] hm', fakeIntent({ noTimeout: true }));
    expect(f.sent).toEqual(['[GAMBLE] hm']);
    expect(mocked.bumpHouseEvents).not.toHaveBeenCalled();
  });

  it('[DEAL:45] deals at stake 45 at this channel', async () => {
    mocked.bjDeal.mockReturnValueOnce({
      natural: false,
      session: { player: ['A', '5'], dealer: ['K', '9'] },
      playerValue: 16,
    });
    const f = await complete('deal me in [DEAL:45]');
    expect(mocked.bjDeal).toHaveBeenCalledWith('c1', 'u1', 'gambler1', 45);
    const [patter, table] = f.sent[0].split('\n\n');
    expect(patter).toBe('deal me in');
    expect(table).toContain('THE TABLE** (45s stake)');
    expect(table).toContain('(16)');
  });

  for (const [raw, stake] of [
    ['[DEAL]', 60],
    ['[DEAL:2]', 5],
    ['[DEAL:999]', 300],
  ] as const) {
    it(`${raw} → stake ${stake}`, async () => {
      mocked.bjDeal.mockReturnValueOnce({
        natural: false,
        session: { player: ['2', '3'], dealer: ['4', '5'] },
        playerValue: 5,
      });
      await complete(raw);
      expect(mocked.bjDeal).toHaveBeenCalledWith('c1', 'u1', 'gambler1', stake);
    });
  }

  it('[HIT] with no live hand', async () => {
    mocked.bjHit.mockReturnValueOnce(null);
    const f = await complete('[HIT]');
    expect(mocked.bjHit).toHaveBeenCalledWith('c1', 'u1');
    expect(f.sent[0]).toContain('no live hand for gambler1');
  });

  it('[HIT] bust boxes for the session stake', async () => {
    mocked.bjHit.mockReturnValueOnce({
      bust: true,
      drawn: 'K',
      playerValue: 25,
      session: { stake: 60, player: ['K', '5', 'K'], dealer: ['9', '7'] },
    });
    const f = await complete('[HIT]');
    expect(f.timeouts).toEqual([[60, 'Blackjack bust — 25, staked 60s']]);
    expect(mocked.recordTableServed).toHaveBeenCalledWith('u1', 'gambler1', 60);
    expect(f.sent[0]).toContain('BUST — THE BOX. 60s.');
  });

  it('[STAND] win pays the stake in cred', async () => {
    mocked.bjStand.mockReturnValueOnce({
      outcome: 'win',
      dealerValue: 22,
      playerValue: 19,
      session: { stake: 60, player: ['K', '9'], dealer: ['K', '6', '6'] },
    });
    const f = await complete('[STAND]');
    expect(mocked.adjustCred).toHaveBeenCalledWith('u1', 'gambler1', 60);
    expect(f.sent[0]).toContain('WIN +60 cred');
    expect(f.timeouts).toEqual([]);
  });

  for (const [raw, stake] of [
    ['[SLOTS]', 30],
    ['[SLOTS:500]', 120],
    ['[SLOTS:1]', 5],
  ] as const) {
    it(`${raw} → spinSlots(${stake})`, async () => {
      mocked.spinSlots.mockReturnValueOnce({ reels: ['🍒', '🍋', '🔔'], credDelta: 0, boxSeconds: 0, label: 'nothing' });
      const f = await complete(raw);
      expect(mocked.spinSlots).toHaveBeenCalledWith(stake);
      expect(f.sent[0]).toContain(`THE REELS** (${stake}s a pull)`);
    });
  }

  it('[DEAL] and [HIT] together: only the deal runs, both markers are stripped', async () => {
    mocked.bjDeal.mockReturnValueOnce({
      natural: false,
      session: { player: ['2', '3'], dealer: ['4', '5'] },
      playerValue: 5,
    });
    const f = await complete('go [DEAL] [HIT]');
    expect(mocked.bjDeal).toHaveBeenCalledTimes(1);
    expect(mocked.bjHit).not.toHaveBeenCalled();
    expect(f.sent[0].split('\n\n')[0]).toBe('go');
  });

  for (const [raw, secs, name] of [
    ['[WHEEL]', 60, undefined],
    ['[WHEEL:30:bob]', 30, 'bob'],
    ['[WHEEL:0]', 60, undefined],
    ['[wheel:45: ann ]', 45, 'ann'],
  ] as const) {
    it(`${raw} → spinChannelWheel(${secs}, ${name})`, async () => {
      const f = await complete(`spin ${raw}`);
      expect(f.wheels).toEqual([[secs, name]]);
      const [patter, verdict] = f.sent[0].split('\n\n');
      expect(patter).toBe('spin');
      expect(verdict).toContain('WHEEL OF FATE');
      expect(verdict).toContain('**Vic**');
    });
  }

  it('[TIMEOUT:10] [GAMBLE] [WHEEL] all fire, in that order, verdicts appended in order', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const f = await complete('chaos [TIMEOUT:10] [GAMBLE] [WHEEL]');
    expect(f.timeouts).toEqual([[10, 'Coach Artie warden discipline']]);
    expect(f.wheels).toEqual([[60, undefined]]);
    const parts = f.sent[0].split('\n\n');
    // the [WHEEL] strip runs after the roulette verdict was appended, so its trim no longer
    // reaches the spaces the earlier strips left behind
    expect(parts[0]).toBe('chaos   ');
    expect(parts[1]).toContain('THE WHEEL');
    expect(parts[2]).toContain('WHEEL OF FATE');
  });
});

describe('output safety floor on the final reply', () => {
  it('a slur suppresses the whole reply', async () => {
    const f = await complete('you absolute retard');
    expect(f.sent).toEqual([]);
  });
  it('leaked prompt scaffolding suppresses the whole reply', async () => {
    const f = await complete('Pinned memory: something internal');
    expect(f.sent).toEqual([]);
  });
});

describe('streaming scrub of control tokens', () => {
  async function stream(partial: string): Promise<Fake> {
    vi.useFakeTimers();
    const f = fakeIntent();
    h.state.handlers = null;
    await processUserIntent(f.intent, { enableTyping: false, enableStreaming: true });
    vi.advanceTimersByTime(2000);
    await h.state.handlers!.onProgress({ status: 'processing', partialResponse: partial });
    return f;
  }

  const ROWS: Array<[string, string]> = [
    ['Hello [SILENT] there', 'Hello  there'],
    ['Hello there [SILEN', 'Hello there '],
    ['Hold on [TIMEO', 'Hold on '],
    ['ok [TIMEOUT:60] bye', 'ok  bye'],
    ['[GAMBLE:60:30] spin', ' spin'],
    ['deal [DEAL:40] [HIT] [STAND] [SLOTS:9] [WHEEL:20:bob] now', 'deal      now'],
    ['tag <capability name="x"/> after', 'tag  after'],
  ];
  for (const [partial, shown] of ROWS) {
    it(JSON.stringify(partial), async () => {
      const f = await stream(partial);
      expect(f.sent).toEqual([shown]);
    });
  }
});

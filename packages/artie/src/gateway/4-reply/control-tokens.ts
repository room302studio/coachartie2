/**
 * Control tokens: the bracketed markers a reply can carry that are instructions, not text.
 *
 *   [SILENT]                      stay silent (a leading marker silences the whole reply)
 *   [TIMEOUT] / [TIMEOUT:NN]      warden timeout of the person Artie is replying to
 *   [GAMBLE] / [GAMBLE:NN[:P]]    timeout roulette, self-spin          (casino)
 *   [DEAL[:NN]] [HIT] [STAND]     blackjack                             (casino)
 *   [SLOTS[:NN]]                  slots                                 (casino)
 *   [WHEEL[:NN[:name]]]           Wheel of Fate, third-party spin       (casino)
 *
 * parseControlToken() reads one kind into a discriminated union with today's defaults and
 * clamps; parseControlTokens() lists every kind present. applyControlTokens() is the
 * finished-reply handling moved verbatim out of stream-reply's onComplete (wave 5): each
 * token fires in this fixed order on the text the previous one left, so one reply can carry
 * several. The regexes are today's, unchanged (waves 7/10 own any change).
 */

import { isSilent } from '../../shared/clean-llm-output.js';
import type { UserIntent } from './stream-reply.js';
import {
  recordSelfSpin,
  adjustCred,
  recordTableServed,
  bjDeal,
  bjHit,
  bjStand,
  bjFmt,
  spinSlots,
  bumpHouseEvents,
  houseFlourish,
  CASINO_OPEN,
} from '../games/casino.js';

export { isSilent };

export type ControlToken =
  | { kind: 'silent' }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'gamble'; stake: number; odds: number }
  | { kind: 'deal'; stake: number }
  | { kind: 'hit' }
  | { kind: 'stand' }
  | { kind: 'slots'; stake: number }
  | { kind: 'wheel'; seconds: number; target: string | undefined };

export type ControlTokenKind = ControlToken['kind'];

type Parser<K extends ControlTokenKind> = (text: string) => Extract<ControlToken, { kind: K }> | null;

const PARSERS: { [K in ControlTokenKind]: Parser<K> } = {
  // Only a LEADING [SILENT] means silence; an embedded one is just stripped.
  silent: (text) => (isSilent(text) ? { kind: 'silent' } : null),
  timeout: (text) => {
    const m = text.match(/\[TIMEOUT(?::(\d{1,3}))?\]/i);
    return m
      ? { kind: 'timeout', seconds: Math.min(300, Math.max(5, parseInt(m[1] || '30', 10) || 30)) }
      : null;
  },
  gamble: (text) => {
    const m = text.match(/\[GAMBLE(?::(\d{1,3})(?::(\d{1,2}))?)?\]/i);
    return m
      ? {
          kind: 'gamble',
          stake: Math.min(300, Math.max(5, parseInt(m[1] || '60', 10) || 60)),
          odds: Math.min(90, Math.max(10, parseInt(m[2] || '50', 10) || 50)),
        }
      : null;
  },
  deal: (text) => {
    const m = text.match(/\[DEAL(?::(\d{1,3}))?\]/i);
    return m ? { kind: 'deal', stake: Math.min(300, Math.max(5, parseInt(m[1] || '60', 10) || 60)) } : null;
  },
  hit: (text) => (text.match(/\[HIT\]/i) ? { kind: 'hit' } : null),
  stand: (text) => (text.match(/\[STAND\]/i) ? { kind: 'stand' } : null),
  slots: (text) => {
    const m = text.match(/\[SLOTS(?::(\d{1,3}))?\]/i);
    return m ? { kind: 'slots', stake: Math.min(120, Math.max(5, parseInt(m[1] || '30', 10) || 30)) } : null;
  },
  wheel: (text) => {
    const m = text.match(/\[WHEEL(?::(\d{1,3}))?(?::([^\]\n]{1,32}))?\]/i);
    return m
      ? { kind: 'wheel', seconds: parseInt(m[1] || '60', 10) || 60, target: m[2]?.trim() || undefined }
      : null;
  },
};

/** The first token of one kind in the text, or null. */
export function parseControlToken<K extends ControlTokenKind>(
  text: string,
  kind: K
): Extract<ControlToken, { kind: K }> | null {
  return (PARSERS[kind] as Parser<K>)(text);
}

/** Order applyControlTokens handles them in. */
const HANDLING_ORDER: ControlTokenKind[] = ['timeout', 'silent', 'gamble', 'deal', 'hit', 'stand', 'slots', 'wheel'];

/** Every control token kind present in the text (first occurrence of each), in handling order. */
export function parseControlTokens(text: string): ControlToken[] {
  return HANDLING_ORDER.map((kind) => parseControlToken(text, kind)).filter(
    (t): t is ControlToken => t !== null
  );
}

// Strip patterns, one per handling stage. `casino` is the closed-floor sweep; `stream` is
// the mid-stream scrub of every complete marker.
const STRIP = {
  timeout: /\[TIMEOUT(?::\d{1,3})?\]/gi,
  silent: /\[SILENT\]/gi,
  casino:
    /\[(?:GAMBLE(?::\d{1,3}){0,2}|WHEEL(?::[^\]\n]{1,40})?|DEAL(?::\d{1,3})?|HIT|STAND|SLOTS(?::\d{1,3})?)\]/gi,
  gamble: /\[GAMBLE(?::\d{1,3}){0,2}\]/gi,
  table: /\[(?:DEAL(?::\d{1,3})?|HIT|STAND|SLOTS(?::\d{1,3})?)\]/gi,
  wheel: /\[WHEEL(?::[^\]\n]{1,40})?\]/gi,
  stream: /\[(?:SILENT|TIMEOUT(?::\d{1,3})?|GAMBLE(?::\d{1,3}){0,2}|WHEEL(?::[^\]\n]{1,40})?|DEAL(?::\d{1,3})?|HIT|STAND|SLOTS(?::\d{1,3})?)\]/gi,
} as const;

/** Remove every marker of one stage (no trimming; callers trim where they always did). */
export function stripControlTokens(text: string, stage: keyof typeof STRIP): string {
  return text.replace(STRIP[stage], '');
}

/**
 * Mid-stream scrub: strip complete [SILENT]/[TIMEOUT]/casino tokens and hold back a possibly
 * incomplete marker at the tail so "[SILEN"/"[TIMEO" never gets posted mid-stream (that's
 * how literal "[SILENT]" leaked into the channel).
 */
export function scrubStreamingTokens(text: string): string {
  return stripControlTokens(text, 'stream').replace(/\[[A-Za-z]{0,8}(?::[^\]\n]{0,40})?$/, '');
}

/** Attach the house's deteriorating inner monologue to a verdict (Discord small-text). */
function withMelt(verdict: string): string {
  const aside = houseFlourish();
  return aside ? `${verdict}\n-# ${aside}` : verdict;
}

/**
 * Handle the control tokens of a finished reply (already capability-cleaned): fire the
 * timeout, apply [SILENT], run the casino games, and return what is left to post, with any
 * game verdicts appended.
 */
export async function applyControlTokens(cleanResult: string, intent: UserIntent): Promise<string> {
  // WARDEN TIMEOUT: if Artie marked [TIMEOUT] / [TIMEOUT:NN], time out the person he is
  // replying to (guardrails enforced in intent.timeoutAuthor), then strip the marker.
  const _toMatch = parseControlToken(cleanResult, 'timeout');
  if (_toMatch && typeof (intent as any).timeoutAuthor === 'function') {
    const _secs = _toMatch.seconds;
    void (intent as any).timeoutAuthor(_secs, 'Coach Artie warden discipline');
    cleanResult = stripControlTokens(cleanResult, 'timeout').trim();
  }
  // [SILENT] handling: a leading marker means "stay silent" even if chatter
  // follows it; a stray embedded marker gets stripped so it never reaches
  // the channel (with a proxy prefix it was posting verbatim).
  if (isSilent(cleanResult)) {
    cleanResult = '';
  } else {
    cleanResult = stripControlTokens(cleanResult, 'silent').trim();
  }
  // TIMEOUT ROULETTE — SELF-SPIN: [GAMBLE] / [GAMBLE:NN] / [GAMBLE:NN:P]. The gambler
  // is the person Artie is replying to; playing is consent. The dice roll HERE,
  // server-side, after the LLM has finished talking — it cannot rig, predict, or fake
  // the outcome. P = survival odds percent (10-90); surviving pays yard cred at fair
  // odds (stake × (100−P)/P) into the persistent house ledger. On a loss the timeout
  // is real (same gate/cooldown as warden discipline). If the box mechanism jams
  // (cooldown, protected user), the verdict says so instead of lying about a served
  // sentence — and the ledger doesn't record time that wasn't served.
  // CASINO CLOSED: if the floor is shut, any stray game markers are stripped and
  // no game logic runs — the ledger stays frozen exactly where the melt left it.
  if (!CASINO_OPEN) {
    cleanResult = stripControlTokens(cleanResult, 'casino').trim();
  }
  const _gMatch = CASINO_OPEN ? parseControlToken(cleanResult, 'gamble') : null;
  if (_gMatch && typeof (intent as any).timeoutAuthor === 'function') {
    bumpHouseEvents();
    const _stake = _gMatch.stake;
    const _odds = _gMatch.odds;
    cleanResult = stripControlTokens(cleanResult, 'gamble').trim();
    const _roll = Math.floor(Math.random() * 100) + 1; // 1-100, shown for legibility
    const _won = _roll <= _odds;
    const _payout = Math.max(1, Math.round((_stake * (100 - _odds)) / _odds));
    let _verdict: string;
    if (_won) {
      const _e = recordSelfSpin(intent.userId, intent.username || 'gambler', true, _payout, 0);
      const _safe = [
        `The box goes hungry tonight.`,
        `Walk away. Never come back. (Come back.)`,
        `The house glares, but pays.`,
      ];
      _verdict =
        `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟩 **SAFE.** ` +
        `${_safe[Math.floor(Math.random() * _safe.length)]} ` +
        `Payout **+${_payout} cred** → ${_e.cred} cred (${_e.streak > 1 ? `W${_e.streak} streak` : 'fresh win'}).`;
    } else {
      const _landed = await (intent as any).timeoutAuthor(
        _stake,
        `Timeout roulette — rolled ${_roll} vs ${_odds}, staked ${_stake}s`
      );
      if (_landed) {
        const _e = recordSelfSpin(intent.userId, intent.username || 'gambler', false, 0, _stake);
        const _loss = [
          `The house thanks you for your patronage.`,
          `${_stake} seconds of contemplative silence, effective immediately.`,
          `No refunds. The wheel loves you.`,
        ];
        _verdict =
          `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟥 **THE BOX. ${_stake}s.** ` +
          `${_loss[Math.floor(Math.random() * _loss.length)]} ` +
          `(${_e.cred} cred, ${_e.served}s lifetime served${_e.streak < -1 ? `, L${-_e.streak} skid` : ''})`;
      } else {
        _verdict = `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟥 THE BOX — but the mechanism jammed. Sentence commuted. The house is FURIOUS.`;
      }
    }
    _verdict = withMelt(_verdict);
    cleanResult = cleanResult ? `${cleanResult}\n\n${_verdict}` : _verdict;
  }
  // BLACKJACK & SLOTS — real server-side games. The LLM's patter is flavor; the
  // appended TABLE/REELS block is the actual cards/reels, dealt here where the
  // model can't fudge them. Stakes are real: busts and flushes hit the same
  // timeoutAuthor path as roulette; wins pay yard cred into the ledger.
  const _tableChannel = String((intent.context as any)?.channelId || 'dm');
  const _gambler = intent.username || 'gambler';
  const _dealM = CASINO_OPEN ? parseControlToken(cleanResult, 'deal') : null;
  const _hitM = CASINO_OPEN ? parseControlToken(cleanResult, 'hit') : null;
  const _standM = CASINO_OPEN ? parseControlToken(cleanResult, 'stand') : null;
  const _slotsM = CASINO_OPEN ? parseControlToken(cleanResult, 'slots') : null;
  if (_dealM || _hitM || _standM || _slotsM) {
    bumpHouseEvents();
    cleanResult = stripControlTokens(cleanResult, 'table').trim();
    let _house = '';
    if (_dealM) {
      const _stake = _dealM.stake;
      const d = bjDeal(_tableChannel, intent.userId, _gambler, _stake);
      if (d.natural) {
        const _pay = Math.round(_stake * 1.5);
        if (d.dealerNatural) {
          _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} (21) · dealer: ${bjFmt(d.session.dealer)} (21). **DOUBLE BLACKJACK — PUSH.** Nobody bleeds, nobody eats.`;
        } else {
          const _e = adjustCred(intent.userId, _gambler, _pay);
          _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} — **BLACKJACK OFF THE DEAL.** Dealer: ${bjFmt(d.session.dealer)} (${d.dealerValue}). Payout **+${_pay} cred** → ${_e.cred}.`;
        }
      } else {
        _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} (${d.playerValue}) · dealer shows ${bjFmt([d.session.dealer[0]])} + 🂠. Hit or stand.`;
      }
    } else if (_hitM) {
      const h = bjHit(_tableChannel, intent.userId);
      if (!h) {
        _house = `🃏 **THE TABLE** — no live hand for ${_gambler}. Cards don't deal themselves, sport — ask for a deal.`;
      } else if (h.bust) {
        const _landed = await (intent as any).timeoutAuthor?.(
          h.session.stake,
          `Blackjack bust — ${h.playerValue}, staked ${h.session.stake}s`
        );
        const _e = _landed
          ? recordTableServed(intent.userId, _gambler, h.session.stake)
          : null;
        _house = `🃏 **THE TABLE** — you draw ${bjFmt([h.drawn])} → ${bjFmt(h.session.player)} (${h.playerValue}). 🟥 **BUST — THE BOX. ${h.session.stake}s.**${_e ? ` (${_e.served}s lifetime served)` : ' The mechanism jammed — sentence commuted, the house seethes.'}`;
      } else {
        _house = `🃏 **THE TABLE** — you draw ${bjFmt([h.drawn])} → ${bjFmt(h.session.player)} (${h.playerValue}). Dealer shows ${bjFmt([h.session.dealer[0]])} + 🂠. Hit or stand.`;
      }
    } else if (_standM) {
      const s = bjStand(_tableChannel, intent.userId);
      if (!s) {
        _house = `🃏 **THE TABLE** — no live hand for ${_gambler}. Standing on nothing is very zen, but ask for a deal first.`;
      } else if (s.outcome === 'win') {
        const _e = adjustCred(intent.userId, _gambler, s.session.stake);
        _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}${s.dealerValue > 21 ? ' — BUST' : ''}). You: ${s.playerValue}. 🟩 **WIN +${s.session.stake} cred** → ${_e.cred}.`;
      } else if (s.outcome === 'push') {
        _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}). You: ${s.playerValue}. **PUSH.** The felt keeps its secrets.`;
      } else {
        const _landed = await (intent as any).timeoutAuthor?.(
          s.session.stake,
          `Blackjack loss — ${s.playerValue} vs dealer ${s.dealerValue}, staked ${s.session.stake}s`
        );
        const _e = _landed
          ? recordTableServed(intent.userId, _gambler, s.session.stake)
          : null;
        _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}). You: ${s.playerValue}. 🟥 **HOUSE WINS — THE BOX. ${s.session.stake}s.**${_e ? ` (${_e.served}s lifetime served)` : ' The mechanism jammed — sentence commuted, the house seethes.'}`;
      }
    } else if (_slotsM) {
      const _stake = _slotsM.stake;
      const r = spinSlots(_stake);
      const _row = r.reels.join(' ');
      if (r.credDelta > 0) {
        const _e = adjustCred(intent.userId, _gambler, r.credDelta);
        _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — **${r.label.toUpperCase()}! +${r.credDelta} cred** → ${_e.cred}.`;
      } else if (r.boxSeconds > 0) {
        const _landed = await (intent as any).timeoutAuthor?.(
          r.boxSeconds,
          `Slots — ${r.label}, ${r.boxSeconds}s`
        );
        if (_landed) recordTableServed(intent.userId, _gambler, r.boxSeconds);
        _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — 🟥 **${r.label.toUpperCase()}. THE BOX: ${r.boxSeconds}s.**${_landed ? '' : ' The mechanism jammed — the toilet gods show mercy.'}`;
      } else {
        _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — nothing. The house keeps your quarter.`;
      }
    }
    if (_house) {
      _house = withMelt(_house);
      cleanResult = cleanResult ? `${cleanResult}\n\n${_house}` : _house;
    }
  }
  // WHEEL OF FATE — THIRD-PARTY SPIN: [WHEEL] / [WHEEL:NN] / [WHEEL:NN:name]. The
  // victim pool is humans recently active in the channel (vetted through the same
  // protection list as warden timeouts); target picking, the roll, and the real
  // timeout all happen in the discord handler — server-side, unriggable.
  const _wMatch = CASINO_OPEN ? parseControlToken(cleanResult, 'wheel') : null;
  if (_wMatch && typeof (intent as any).spinChannelWheel === 'function') {
    bumpHouseEvents();
    cleanResult = stripControlTokens(cleanResult, 'wheel').trim();
    const _spin = await (intent as any).spinChannelWheel(_wMatch.seconds, _wMatch.target);
    let _verdict: string;
    if (!_spin.target) {
      _verdict = `🎡 **WHEEL OF FATE** — the wheel spun, wobbled, and found no one it could legally eat. The house files a formal complaint.`;
    } else if (!_spin.boxed) {
      _verdict = `🎡 **WHEEL OF FATE** — the wheel scans the room... locks onto **${_spin.target}**... roll ${_spin.roll}/100 (box on 51+): 🟩 **SPARED.** The wheel is merciful. Today.`;
    } else if (_spin.landed) {
      _verdict = `🎡 **WHEEL OF FATE** — the wheel scans the room... locks onto **${_spin.target}**... roll ${_spin.roll}/100 (box on 51+): 🟥 **THE BOX. ${_spin.stake}s.** Fate sends its regards.`;
    } else {
      _verdict = `🎡 **WHEEL OF FATE** — the wheel locks onto **${_spin.target}**... roll ${_spin.roll}/100: 🟥 THE BOX — but the mechanism jammed. **${_spin.target}** walks. The house is FURIOUS.`;
    }
    _verdict = withMelt(_verdict);
    cleanResult = cleanResult ? `${cleanResult}\n\n${_verdict}` : _verdict;
  }
  return cleanResult;
}

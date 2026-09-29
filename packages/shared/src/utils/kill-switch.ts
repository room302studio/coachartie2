import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * The global kill switch: while the KILL_SWITCH file exists, nothing generates.
 *
 * It used to be checked in exactly one place — the discord message handler — so everything
 * that didn't start as a Discord message (the capabilities scheduler, observation summaries,
 * memory tagging, reflection, social-media behaviour, the morning briefing, SMS/IRC/Slack/
 * email via /chat) kept spending with Artie "muted". It is now asserted at every LLM call
 * site, in both processes, which share the file (both PM2 apps run with cwd packages/<name>,
 * so the default resolves to the repo root in each).
 *
 * Two kinds of mute share the one file, told apart by its content:
 *  - manual: anything a human (or POST /api/killswitch) wrote. Never touched by automation.
 *  - budget: written by the daily spend cap. Starts with BUDGET_MUTE_MARKER, carries the ET
 *    day it tripped on, and is lifted automatically at the next ET midnight.
 */

export const BUDGET_MUTE_MARKER = 'BUDGET_MUTE';

export function getKillSwitchPath(): string {
  return process.env.KILL_SWITCH_PATH || join(process.cwd(), '..', '..', 'KILL_SWITCH');
}

export interface BudgetMuteInfo {
  /** ET calendar day (YYYY-MM-DD) the cap tripped on. */
  day: string;
  spentUsd: number;
  budgetUsd: number;
  at: string;
}

export type KillSwitchState =
  | { muted: false }
  | { muted: true; kind: 'manual' }
  | ({ muted: true; kind: 'budget' } & BudgetMuteInfo);

export function parseKillSwitch(content: string): KillSwitchState {
  const trimmed = content.trim();
  if (trimmed.startsWith(BUDGET_MUTE_MARKER)) {
    try {
      const info = JSON.parse(trimmed.slice(BUDGET_MUTE_MARKER.length).trim()) as BudgetMuteInfo;
      if (typeof info.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(info.day)) {
        return { muted: true, kind: 'budget', ...info };
      }
    } catch {
      // Unparseable budget marker: treat as manual, i.e. never auto-lift something we can't read.
    }
  }
  return { muted: true, kind: 'manual' };
}

export function readKillSwitch(path: string = getKillSwitchPath()): KillSwitchState {
  if (!existsSync(path)) return { muted: false };
  try {
    return parseKillSwitch(readFileSync(path, 'utf8'));
  } catch {
    // Exists but unreadable: still muted, and not ours to lift.
    return { muted: true, kind: 'manual' };
  }
}

/** Hot-path check: a single stat. */
export function isGenerationMuted(path: string = getKillSwitchPath()): boolean {
  return existsSync(path);
}

export class GenerationMutedError extends Error {
  constructor(where: string) {
    super(`🔇 GENERATION MUTED (kill switch active) — ${where} skipped`);
    this.name = 'GenerationMutedError';
  }
}

/** Throw before any paid model call while the kill switch is on. */
export function assertGenerationAllowed(where: string, path: string = getKillSwitchPath()): void {
  if (isGenerationMuted(path)) throw new GenerationMutedError(where);
}

export function writeBudgetMute(info: BudgetMuteInfo, path: string = getKillSwitchPath()): void {
  writeFileSync(path, `${BUDGET_MUTE_MARKER} ${JSON.stringify(info)}\n`);
}

export function writeManualMute(path: string = getKillSwitchPath()): void {
  writeFileSync(path, `muted at ${new Date().toISOString()}\n`);
}

export function clearKillSwitch(path: string = getKillSwitchPath()): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Manual unmute during a budget mute = "I know, let him talk today". Recorded per ET day so
 * the very next generation doesn't re-trip the cap; it expires on its own at midnight.
 */
export function budgetOverridePath(path: string = getKillSwitchPath()): string {
  return `${path}.budget-override`;
}

export function readBudgetOverrideDay(path: string = getKillSwitchPath()): string | null {
  try {
    const p = budgetOverridePath(path);
    return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

export function writeBudgetOverride(day: string, path: string = getKillSwitchPath()): void {
  writeFileSync(budgetOverridePath(path), `${day}\n`);
}

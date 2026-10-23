import type { ColorKey } from './registry'

/**
 * The states a status pill or tag can show. Each tone has its own `statusPill.<tone>Background` and `Foreground` keys,
 * and a pill always carries a word (and usually a glyph), so the tone is never the only sign of the state.
 * - running: work in progress (an execution, a restore, a running job);
 * - success: finished well (succeeded, healthy);
 * - warning: needs attention (stopping, read-only, single user);
 * - critical: failed or at risk, and the Production environment tag;
 * - info: a fact worth noticing that is not a problem (a Staging environment);
 * - neutral: no state colour (canceled, a Test environment).
 */
export const statusTones = ['running', 'success', 'warning', 'critical', 'info', 'neutral'] as const
export type StatusTone = typeof statusTones[number]
export const isStatusTone = (value: unknown): value is StatusTone => typeof value === 'string' && (statusTones as readonly string[]).includes(value)

/** The fill and text keys of a tone's pill. */
export function toneKeys(tone: StatusTone): { readonly background: ColorKey; readonly foreground: ColorKey } {
  return { background: `statusPill.${tone}Background`, foreground: `statusPill.${tone}Foreground` }
}

/** Thresholds a metric tile can cross; each draws its own outline (`tile.warningBorder`, `tile.criticalBorder`). */
export const tileTones = ['warning', 'critical'] as const
export type TileTone = typeof tileTones[number]

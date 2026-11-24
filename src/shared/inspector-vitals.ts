import { z } from 'zod'

export const vitalsLimits = {
  minWidth: 200,
  maxWidth: 440,
  /** Maximum fraction of the inspector container width the Vitals rail may take. */
  maxShare: 0.48,
  /** Below this container width (px), the Vitals rail and sash hide so no second vertical scroller stacks. */
  narrowHideWidth: 680,
  /** Keyboard resize step on the Vitals separator (px). */
  step: 16,
  /** Bounded file size for `<userData>/inspector-vitals.json`. */
  fileBytes: 4096
} as const

export type InspectorSurface = 'full' | 'peek'

export interface VitalsSurfacePrefs {
  readonly open: boolean
  readonly width: number
}

export interface InspectorVitalsPrefs {
  readonly full: VitalsSurfacePrefs
  readonly peek: VitalsSurfacePrefs
}

export interface InspectorVitalsFile extends InspectorVitalsPrefs {
  readonly version: 1
}

export interface InspectorVitalsLoad {
  readonly prefs: InspectorVitalsPrefs
  readonly warning?: string
}

export const defaultInspectorVitals: InspectorVitalsPrefs = {
  full: { open: true, width: 272 },
  peek: { open: true, width: 236 }
}

/** Returns a fresh copy of the default full and peek Vitals preferences. */
export function defaultInspectorVitalsPrefs(): InspectorVitalsPrefs {
  return {
    full: { ...defaultInspectorVitals.full },
    peek: { ...defaultInspectorVitals.peek }
  }
}

/** Maximum Vitals width (px) for the given container width, bounded by `vitalsLimits.maxWidth` and `48%` of container width. */
export function vitalsMaxWidth(containerWidth?: number): number {
  if (containerWidth === undefined || !Number.isFinite(containerWidth) || containerWidth <= 0) return vitalsLimits.maxWidth
  return Math.max(vitalsLimits.minWidth, Math.min(vitalsLimits.maxWidth, Math.floor(containerWidth * vitalsLimits.maxShare)))
}

/** Clamps a Vitals width (px) to `[minWidth, vitalsMaxWidth(containerWidth)]`, falling back to the surface default for non-finite values. */
export function clampVitalsWidth(width: number, surface: InspectorSurface = 'full', containerWidth?: number): number {
  const max = vitalsMaxWidth(containerWidth)
  const raw = Number.isFinite(width) ? Math.round(width) : defaultInspectorVitals[surface].width
  return Math.max(vitalsLimits.minWidth, Math.min(max, raw))
}

/**
 * Keyboard resize on the right-docked Vitals separator: ArrowLeft widens (+16 px), ArrowRight narrows (-16 px), and
 * Home resets to the surface's default width. Undefined for any other key.
 */
export function vitalsWidthKey(width: number, key: string, surface: InspectorSurface, containerWidth?: number): number | undefined {
  switch (key) {
    case 'ArrowLeft': return clampVitalsWidth(width + vitalsLimits.step, surface, containerWidth)
    case 'ArrowRight': return clampVitalsWidth(width - vitalsLimits.step, surface, containerWidth)
    case 'Home': return clampVitalsWidth(defaultInspectorVitals[surface].width, surface, containerWidth)
    default: return undefined
  }
}

const vitalsSurfaceSchema = z.object({
  open: z.boolean(),
  width: z.number().finite()
}).strict()

export const inspectorVitalsSchema = z.object({
  full: vitalsSurfaceSchema,
  peek: vitalsSurfaceSchema
}).strict()

export const inspectorVitalsFileSchema = z.object({
  version: z.literal(1),
  full: vitalsSurfaceSchema,
  peek: vitalsSurfaceSchema
}).strict()

/** Validates and clamps both surfaces' Vitals preferences. Throws on invalid shape or non-finite values. */
export function parseInspectorVitalsPrefs(value: unknown): InspectorVitalsPrefs {
  const parsed = inspectorVitalsSchema.parse(value)
  return {
    full: { open: parsed.full.open, width: clampVitalsWidth(parsed.full.width, 'full') },
    peek: { open: parsed.peek.open, width: clampVitalsWidth(parsed.peek.width, 'peek') }
  }
}

/** Validates an on-disk `inspector-vitals.json` file and clamps out-of-range widths into bounds. */
export function parseInspectorVitalsFile(value: unknown): InspectorVitalsPrefs {
  const parsed = inspectorVitalsFileSchema.parse(value)
  return {
    full: { open: parsed.full.open, width: clampVitalsWidth(parsed.full.width, 'full') },
    peek: { open: parsed.peek.open, width: clampVitalsWidth(parsed.peek.width, 'peek') }
  }
}

export function inspectorVitalsFile(prefs: InspectorVitalsPrefs): InspectorVitalsFile {
  const normalized = parseInspectorVitalsPrefs(prefs)
  return { version: 1, ...normalized }
}

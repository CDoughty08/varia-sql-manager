// The non-colour half of the design language: type scale, spacing, radii, shadows, motion and bar heights. They are not
// theme keys, so theme files stay colour-only and a theme cannot resize the workbench (fonts are fixed for the same
// reason, in fonts.ts). styles.css's :root mirrors `metricVariables()` and tests/theme-css.test.ts compares the two;
// docs/themes/metrics.md is generated from this file (npx vitest run tests/theme-metrics.test.ts -u).

/** No UI text is smaller than this; chart axis ticks, drawn on a canvas, are the only exception. */
export const minimumFontSize = 11

export interface TypeStep { readonly size: number; readonly line: number; readonly use: string }
/** `--varia-size-<step>` and `--varia-line-<step>`, in px. */
export const typeScale = {
  xs: { size: 11, line: 16, use: 'Status bars, counts, captions, keys, grid headers, side-bar section titles.' },
  sm: { size: 12, line: 16, use: 'Secondary text, chips, buttons, menus, result cells.' },
  md: { size: 13, line: 20, use: 'Body text, tree rows, tabs, dialog fields; the default.' },
  lg: { size: 15, line: 20, use: 'Document and dialog titles.' },
  xl: { size: 20, line: 26, use: 'Headline numbers in live tiles; full-page headings.' }
} as const satisfies Record<string, TypeStep>
export type TypeStepName = keyof typeof typeScale

export interface PendingTypeStep { readonly what: string; readonly selectors: readonly string[]; readonly now: TypeStepName; readonly planned: TypeStepName }
/**
 * Surfaces that keep the size they had before the type scale until the explorer, shell and results PRs restyle them, with
 * the styles.css rules that size them. tests/theme-metrics.test.ts holds each rule to its current step, so moving one to
 * its planned step means removing its entry here.
 */
export const typeScalePending: readonly PendingTypeStep[] = [
  { what: 'Object Explorer rows', selectors: ['.explorer-row'], now: 'sm', planned: 'md' },
  { what: 'Document tabs (buttons) and dialog fields', selectors: ['button', 'select, input'], now: 'sm', planned: 'md' },
  { what: 'Results grid column headers', selectors: ['.rg-ch, .rg-corner'], now: 'sm', planned: 'xs' }
]

/** `--varia-space-0` … `--varia-space-6`, in px: gaps and padding of new surfaces. */
export const spaceScale = [2, 4, 8, 12, 16, 24, 32] as const

/** `--varia-radius-<name>`, in px. Circles (status dots) use 50 %, and 1-2 px indicators keep their own. */
export const radii = {
  sm: { px: 4, use: 'Controls, menus, banners, inline editors.' },
  lg: { px: 8, use: 'Dialogs, popovers, cards.' },
  pill: { px: 999, use: 'Status pills and chips.' }
} as const

/**
 * `--varia-shadow-<name>`: offset and blur only, so a rule adds the colour key it draws with
 * (`box-shadow: var(--varia-shadow-menu) var(--varia-widget-shadow)`). Surfaces and cards never cast one.
 */
export const shadows = {
  menu: { y: 4, blur: 12, use: 'Menus, tooltips, drop-down lists, docking guides.' },
  popover: { y: 8, blur: 24, use: 'The command palette, pickers, floating dock groups.' },
  dialog: { y: 16, blur: 48, use: 'Modal dialogs.' }
} as const

/**
 * `--varia-motion-<name>`, in ms, and one easing curve. Transitions are 80 ms for hover and pressed fills, carried only
 * by `:hover` rules so that selection and other state changes are instant, and 120 ms for menus, popovers and dialogs;
 * `prefers-reduced-motion: reduce` sets both to 0. The loops (Varia's spinners, Monaco's codicon spinners and the live
 * dot) have their own periods and stop under reduced motion through `animation: none`. `delay` holds a loading
 * placeholder back (as an animation delay) and is not motion, so reduced motion leaves it alone.
 */
export const motion = {
  fast: { ms: 80, use: 'Hover and pressed fills.' },
  base: { ms: 120, use: 'Menus, popovers and dialogs appearing.' },
  spin: { ms: 1500, use: 'One turn of a loading spinner (a loop).' },
  pulse: { ms: 2000, use: 'One beat of the live dot, 0.5 Hz (a loop).' },
  delay: { ms: 300, use: 'The wait before a loading placeholder appears, so a quick load never flashes one. Not motion: reduced motion keeps it.' }
} as const
export const motionEasing = 'cubic-bezier(0.2, 0, 0, 1)'
/** The transitions reduced motion turns off; loops are stopped per rule instead. */
export const reducedMotion = ['fast', 'base'] as const satisfies readonly (keyof typeof motion)[]

/** The planned use of each height; `densityUse` lists the rules that take it today. */
export interface DensityMetrics {
  /** `--varia-header`: the title bar. */
  readonly header: number
  /** `--varia-bar`: tab strips, the query bar, side-bar headers. */
  readonly bar: number
  /** `--varia-control`: buttons, inputs, selects. */
  readonly control: number
  /** `--varia-row`: tree, grid and list rows. */
  readonly row: number
  /** `--varia-status`: the status bars. */
  readonly status: number
}
export const densityPlanned: Readonly<Record<keyof DensityMetrics, string>> = {
  header: 'The title bar.', bar: 'Tab strips, the query bar, side-bar headers.', control: 'Buttons, inputs, selects.', row: 'Tree, grid and list rows.', status: 'The status bars.'
}
/**
 * The styles.css rules whose height is each token today; tests/theme-metrics.test.ts checks the list both ways. The title
 * bar (34 px), toolbar controls (28 px), padded buttons and inputs, the explorer toolbar (32 px), dock headers (28 px) and grid rows
 * (20 px) keep their sizes until the shell, explorer, results and density PRs move them onto the tokens.
 */
export const densityUse: Readonly<Record<keyof DensityMetrics, readonly string[]>> = {
  header: [], bar: ['.query-tabs', '.document-script-head'], control: ['.icon-button', '.document-verb', '.property-input'], row: ['.explorer-row', '.skeleton-row', '.document-nav-item'], status: ['.status-bar', '.query-status-bar']
}
/** Bar and row heights in px. Compact is the default and the only one :root sets; Comfortable is the planned option. */
export const densities = {
  compact: { header: 40, bar: 36, control: 26, row: 22, status: 24 },
  comfortable: { header: 44, bar: 40, control: 28, row: 26, status: 26 }
} as const satisfies Record<string, DensityMetrics>
export type Density = keyof typeof densities
export const defaultDensity: Density = 'compact'

const px = (value: number) => `${value}px`
const ms = (value: number) => `${value}ms`

/** Every metric custom property with its value, in the order styles.css's :root declares them. */
export function metricVariables(density: Density = defaultDensity): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(Object.entries(typeScale).flatMap(([name, step]) => [[`--varia-size-${name}`, px(step.size)], [`--varia-line-${name}`, px(step.line)]])),
    ...Object.fromEntries(spaceScale.map((value, index) => [`--varia-space-${index}`, px(value)])),
    ...Object.fromEntries(Object.entries(radii).map(([name, radius]) => [`--varia-radius-${name}`, px(radius.px)])),
    ...Object.fromEntries(Object.entries(shadows).map(([name, shadow]) => [`--varia-shadow-${name}`, `0 ${px(shadow.y)} ${px(shadow.blur)}`])),
    ...Object.fromEntries(Object.entries(motion).map(([name, entry]) => [`--varia-motion-${name}`, ms(entry.ms)])),
    '--varia-motion-ease': motionEasing,
    ...densityVariables(density)
  }
}

/** A density's bar and row heights, `--varia-header` … `--varia-status`. */
export function densityVariables(density: Density): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(densities[density]).map(([name, value]) => [`--varia-${name}`, px(value)]))
}

/** What styles.css's `prefers-reduced-motion: reduce` block sets on :root. */
export function reducedMotionVariables(): Readonly<Record<string, string>> {
  return Object.fromEntries(reducedMotion.map(name => [`--varia-motion-${name}`, ms(0)]))
}

const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')

/** docs/themes/metrics.md. */
export function renderMetricDocs(): string {
  const densityRows = (Object.keys(densities.compact) as (keyof DensityMetrics)[]).map(name => [`\`--varia-${name}\``, densities.compact[name], densities.comfortable[name], densityPlanned[name],
    densityUse[name].length ? densityUse[name].map(selector => `\`${selector}\``).join(', ') : 'Not yet'])
  return [
    '# Metric tokens',
    '',
    'Generated from `src/shared/theme/metrics.ts` by `npx vitest run tests/theme-metrics.test.ts -u`; do not edit by hand.',
    '',
    'Sizes, spacing, radii, shadows, motion and bar heights are CSS custom properties on `:root` in',
    '`src/renderer/src/styles.css`. They are not theme keys: theme files hold colours only, so no theme can resize the',
    `workbench. No UI text is smaller than ${minimumFontSize} px; chart axis ticks, drawn on a canvas, are the only exception.`,
    '',
    '## Type scale',
    '',
    table(['Size', 'Line height', 'px', 'Use'], Object.entries(typeScale).map(([name, step]) => [`\`--varia-size-${name}\``, `\`--varia-line-${name}\``, `${step.size} / ${step.line}`, step.use])),
    '',
    'These surfaces keep their earlier size until they are restyled:',
    '',
    table(['Surface', 'Rules', 'Now', 'Planned'], typeScalePending.map(entry => [entry.what, entry.selectors.map(selector => `\`${selector}\``).join(', '), `\`${entry.now}\``, `\`${entry.planned}\``])),
    '',
    '## Spacing',
    '',
    table(['Token', 'px'], spaceScale.map((value, index) => [`\`--varia-space-${index}\``, value])),
    '',
    '## Radii',
    '',
    table(['Token', 'px', 'Use'], Object.entries(radii).map(([name, radius]) => [`\`--varia-radius-${name}\``, radius.px, radius.use])),
    '',
    '## Shadows',
    '',
    'Offset and blur only; a rule adds its colour key, as in `box-shadow: var(--varia-shadow-menu) var(--varia-widget-shadow)`.',
    '',
    table(['Token', 'Value', 'Use'], Object.entries(shadows).map(([name, shadow]) => [`\`--varia-shadow-${name}\``, `\`0 ${shadow.y}px ${shadow.blur}px\``, shadow.use])),
    '',
    '## Motion',
    '',
    `One easing curve, \`--varia-motion-ease\` (\`${motionEasing}\`). Under \`prefers-reduced-motion: reduce\`, ${reducedMotion.map(name => `\`--varia-motion-${name}\``).join(' and ')} are 0 ms, and every looping animation stops, Monaco's codicon spinners included.`,
    '',
    'Only `:hover` rules carry the fast transition, and rules that mark a state (a selected row, the current page or tab, a menu moved to with the keys) set `transition: none`, so state changes are instant.',
    '',
    table(['Token', 'ms', 'Use'], Object.entries(motion).map(([name, entry]) => [`\`--varia-motion-${name}\``, entry.ms, entry.use])),
    '',
    '## Bars and rows',
    '',
    `Compact is the default and the only density \`:root\` sets; Comfortable is planned as an option. The title bar (34 px), toolbar controls (28 px), padded buttons and inputs, the explorer toolbar (32 px), dock headers (28 px) and grid rows (20 px) keep their own heights until they are moved onto these tokens.`,
    '',
    table(['Token', 'Compact px', 'Comfortable px', 'Planned for', 'Sized with it now'], densityRows),
    ''
  ].join('\n')
}

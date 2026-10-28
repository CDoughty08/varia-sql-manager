// Every icon the workbench draws, by id: a codicon (the icon font bundled with Monaco) for generic actions and states, or
// one of Varia's own stroke icons for database objects. The renderer draws them only through Icon.tsx (or
// `codiconClass` where Monaco takes a class name), and catalogues name icons only by these ids, so a node, command or
// document kind cannot point at a glyph that does not exist. docs/icons.md is generated from this file
// (npx vitest run tests/icons.test.ts -u). Erasable TypeScript, so Node's type stripping can load it with the catalogues.

/**
 * Varia's icons, drawn to codicon metrics: a 16 px grid with the drawing inside 1-15 px, `iconStroke` px strokes with
 * round caps and joins, `currentColor`, no fills. Straight lines sit on half pixels, so they are sharp at 100 % zoom where
 * the icon's box starts on a whole pixel; one placed after text of fractional width (document tabs after the first) is not.
 * An id here replaces the codicon of the same name (server, database, table, key): objects look the same in Object
 * Explorer, menus, the palette and dialogs.
 */
export const svgIcons = {
  varia: { path: 'M13.5 4c0 .97-2.46 1.75-5.5 1.75S2.5 4.97 2.5 4 4.96 2.25 8 2.25s5.5.78 5.5 1.75ZM2.5 4v8c0 .97 2.46 1.75 5.5 1.75s5.5-.78 5.5-1.75V4M5.5 7.5 8 11.5l2.5-4', use: 'The brand mark in the title bar.' },
  server: { path: 'M3.5 2.5h9a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1ZM3.5 9.5h9a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1ZM4.5 4.5h1M4.5 11.5h1', use: 'Servers: Object Explorer\'s server nodes, saved and discovered connections.' },
  database: { path: 'M13.5 4c0 .97-2.46 1.75-5.5 1.75S2.5 4.97 2.5 4 4.96 2.25 8 2.25s5.5.78 5.5 1.75ZM2.5 4v8c0 .97 2.46 1.75 5.5 1.75s5.5-.78 5.5-1.75V4M2.5 8c0 .97 2.46 1.75 5.5 1.75s5.5-.78 5.5-1.75', use: 'Databases, and query documents.' },
  table: { path: 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2.5 6.5h11M2.5 10.5h11M6.5 6.5v7', use: 'Tables and table types, the table designer.' },
  view: { path: 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2.5 5.5h11M4.5 9.5c1-1.33 2.17-2 3.5-2s2.5.67 3.5 2c-1 1.33-2.17 2-3.5 2s-2.5-.67-3.5-2ZM8 9.5h.01', use: 'Views.' },
  procedure: { path: 'M4.5 1.5h5l3 3v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM9.5 1.5v3h3M6.5 7.5v4.5l3.5-2.25Z', use: 'Stored procedures.' },
  key: { path: 'M7 7.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM7 7.5h6.5M11.5 7.5v2M13.5 7.5v1.5', use: 'Keys: primary-key columns, credentials, asymmetric, symmetric and column keys.' },
  login: { path: 'M10.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM3.5 13.5V13a4.5 4 0 0 1 9 0v.5', use: 'Logins.' },
  role: { path: 'M8 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM2.5 13.5v-1a3.5 3.5 0 0 1 7 0v1M10 3.5a2 2 0 0 1 0 4M11 9.2a3.5 3.5 0 0 1 2.5 3.3v1', use: 'Server, database and application roles.' },
  shield: { path: 'M8 1.5l5.5 2v4c0 3.25-2.25 5.5-5.5 7-3.25-1.5-5.5-3.75-5.5-7v-4ZM5.5 8l2 2 3-3.5', use: 'Audits, audit specifications, security policies.' },
  'execution-plan': { path: 'M2.5 2.5h4v4h-4ZM9.5 2.5h4v4h-4ZM9.5 9.5h4v4h-4ZM6.5 4.5h3M7.5 4.5v7h2', use: 'Execution plan documents.' },
  'agent-job': { path: 'M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM7.5 4.5v4h3', use: 'SQL Server Agent: Object Explorer\'s running-jobs chip, and jobs (planned).' },
  'ssis-package': { path: 'M1.5 3.5h13v2h-13ZM2.5 5.5h11v8h-11ZM5.5 9.5h4.5M8.5 8l1.5 1.5-1.5 1.5', use: 'Integration Services packages (planned).' },
  'ssis-environment': { path: 'M2.5 3.5h11M2.5 7.5h11M2.5 11.5h7M13.5 11.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z', use: 'Integration Services environments (planned).' }
} as const satisfies Record<string, { readonly path: string; readonly use: string }>
export type SvgIconId = keyof typeof svgIcons
/** The stroke width of Varia's icons, in px at the 16 px grid. */
export const iconStroke = 1

/** The codicons Varia draws; tests/icons.test.ts checks each exists in the bundled font. */
export const codiconIcons = [
  'add', 'archive', 'arrow-left', 'arrow-small-down', 'book', 'bookmark', 'case-sensitive', 'check', 'chevron-down', 'chevron-right', 'circle-filled',
  'circle-outline', 'circle-slash', 'circuit-board', 'clear-all', 'clippy', 'close', 'close-all', 'cloud', 'code', 'collapse-all', 'comment', 'copy',
  'debug-disconnect', 'debug-pause', 'debug-restart', 'debug-stop', 'device-camera', 'discard', 'edit', 'error', 'file', 'file-code', 'filter',
  'filter-filled', 'folder', 'folder-library', 'folder-opened', 'git-compare', 'go-to-file', 'graph', 'history', 'info', 'insert', 'json', 'law',
  'layers', 'layout', 'link', 'list-flat', 'list-ordered', 'list-tree', 'loading', 'lock', 'milestone', 'multiple-windows', 'new-file', 'output',
  'package', 'pass', 'person', 'play', 'plug', 'project', 'redo', 'references', 'refresh', 'remote', 'remove', 'replace', 'save', 'save-all',
  'save-as', 'screen-full', 'search', 'settings-gear', 'split-horizontal', 'star-empty', 'star-full', 'symbol-color', 'symbol-constant',
  'symbol-field', 'symbol-file', 'symbol-function', 'symbol-key', 'symbol-namespace', 'symbol-numeric', 'symbol-operator', 'symbol-parameter',
  'symbol-ruler', 'symbol-snippet', 'symbol-structure', 'symbol-variable', 'tag', 'tools', 'trash', 'triangle-right', 'type-hierarchy', 'verified',
  'warning', 'watch', 'whitespace', 'window', 'word-wrap', 'workspace-trusted', 'zap', 'zoom-in', 'zoom-out'
] as const
export type CodiconId = typeof codiconIcons[number]

export type IconId = SvgIconId | CodiconId
export type IconSpec = { readonly source: 'svg'; readonly path: string; readonly use: string } | { readonly source: 'codicon' }

const codiconSet: ReadonlySet<string> = new Set(codiconIcons)
/** Every id, Varia's icons first. */
export const iconIds: readonly IconId[] = [...Object.keys(svgIcons) as SvgIconId[], ...codiconIcons]

/** Whether `value` names an icon; an inherited name such as `toString` does not. */
export function isIconId(value: unknown): value is IconId {
  return typeof value === 'string' && (Object.hasOwn(svgIcons, value) || codiconSet.has(value))
}

/** The icon behind an id, or undefined for a string that is not one. */
export function iconSpec(id: string): IconSpec | undefined {
  if (Object.hasOwn(svgIcons, id)) {
    const icon = svgIcons[id as SvgIconId]
    return { source: 'svg', path: icon.path, use: icon.use }
  }
  return codiconSet.has(id) ? { source: 'codicon' } : undefined
}

/** A codicon's class names, for the places that take a class rather than an element: Monaco decorations, and elements
 *  that are the glyph themselves (the tree's twisties, status badges). */
export function codiconClass(id: CodiconId): string {
  return `codicon codicon-${id}`
}

/** docs/icons.md. */
export function renderIconDocs(): string {
  return [
    '# Icons',
    '',
    'Generated from `src/shared/icons.ts` by `npx vitest run tests/icons.test.ts -u`; do not edit by hand.',
    '',
    'Catalogues (commands, Object Explorer kinds and folders, document kinds, dialog pages) name icons only by these ids, and',
    'the renderer draws them only through `Icon.tsx`. Varia\'s own icons are drawn to codicon metrics: a 16 px grid with the',
    `drawing inside 1-15 px, ${iconStroke} px strokes with round caps and joins, \`currentColor\` and no fills. Straight lines sit on`,
    'half pixels, so they are sharp at 100 % zoom where the icon\'s box starts on a whole pixel; one placed after text of',
    'fractional width (document tabs after the first) is not. An id below replaces the codicon of the',
    'same name. Icons are sized with the `--varia-glyph-*` tokens ([metrics](themes/metrics.md)) and coloured',
    'with theme keys; Microsoft\'s SSMS icons are never used.',
    '',
    `## Varia's icons (${Object.keys(svgIcons).length})`,
    '',
    '| Id | Use |',
    '| --- | --- |',
    ...Object.entries(svgIcons).map(([id, icon]) => `| \`${id}\` | ${icon.use} |`),
    '',
    `## Codicons (${codiconIcons.length})`,
    '',
    'From the codicon font bundled with Monaco ([reference](https://microsoft.github.io/vscode-codicons/dist/codicon.html)):',
    '',
    codiconIcons.map(id => `\`${id}\``).join(', ') + '.',
    ''
  ].join('\n')
}

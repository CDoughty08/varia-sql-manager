# Metric tokens

Generated from `src/shared/theme/metrics.ts` by `npx vitest run tests/theme-metrics.test.ts -u`; do not edit by hand.

Sizes, spacing, radii, shadows, motion, icon sizes and bar heights are CSS custom properties on `:root` in
`src/renderer/src/styles.css`. They are not theme keys: theme files hold colours only, so no theme can resize the
workbench. No UI text is smaller than 11 px; chart axis ticks, drawn on a canvas, are the only exception.

## Type scale

| Size | Line height | px | Use |
| --- | --- | --- | --- |
| `--varia-size-xs` | `--varia-line-xs` | 11 / 16 | Status bars, counts, captions, keys, grid headers, side-bar section titles. |
| `--varia-size-sm` | `--varia-line-sm` | 12 / 16 | Secondary text, chips, buttons, menus, result cells. |
| `--varia-size-md` | `--varia-line-md` | 13 / 20 | Body text, tree rows, tabs, dialog fields; the default. |
| `--varia-size-lg` | `--varia-line-lg` | 15 / 20 | Document and dialog titles. |
| `--varia-size-xl` | `--varia-line-xl` | 20 / 26 | Headline numbers in live tiles; full-page headings. |

These surfaces keep their earlier size until they are restyled:

| Surface | Rules | Now | Planned |
| --- | --- | --- | --- |
| Document tabs (buttons) and dialog fields | `button`, `select, input` | `sm` | `md` |
| Results grid column headers | `.rg-ch, .rg-corner` | `sm` | `xs` |

## Spacing

| Token | px |
| --- | --- |
| `--varia-space-0` | 2 |
| `--varia-space-1` | 4 |
| `--varia-space-2` | 8 |
| `--varia-space-3` | 12 |
| `--varia-space-4` | 16 |
| `--varia-space-5` | 24 |
| `--varia-space-6` | 32 |

## Radii

| Token | px | Use |
| --- | --- | --- |
| `--varia-radius-sm` | 4 | Controls, menus, banners, inline editors. |
| `--varia-radius-lg` | 8 | Dialogs, popovers, cards. |
| `--varia-radius-pill` | 999 | Status pills and chips. |

## Shadows

Offset and blur only; a rule adds its colour key, as in `box-shadow: var(--varia-shadow-menu) var(--varia-widget-shadow)`.

| Token | Value | Use |
| --- | --- | --- |
| `--varia-shadow-menu` | `0 4px 12px` | Menus, tooltips, drop-down lists, docking guides. |
| `--varia-shadow-popover` | `0 8px 24px` | The command palette, pickers, floating dock groups. |
| `--varia-shadow-dialog` | `0 16px 48px` | Modal dialogs. |

## Motion

One easing curve, `--varia-motion-ease` (`cubic-bezier(0.2, 0, 0, 1)`). Under `prefers-reduced-motion: reduce`, `--varia-motion-fast` and `--varia-motion-base` are 0 ms, and every looping animation stops, Monaco's codicon spinners included.

Only `:hover` rules carry the fast transition, and rules that mark a state (a selected row, the current page or tab, a menu moved to with the keys) set `transition: none`, so state changes are instant.

| Token | ms | Use |
| --- | --- | --- |
| `--varia-motion-fast` | 80 | Hover and pressed fills. |
| `--varia-motion-base` | 120 | Menus, popovers and dialogs appearing. |
| `--varia-motion-spin` | 1500 | One turn of a loading spinner (a loop). |
| `--varia-motion-pulse` | 2000 | One beat of the live dot, 0.5 Hz (a loop). |
| `--varia-motion-delay` | 300 | The wait before a loading placeholder appears, so a quick load never flashes one. Not motion: reduced motion keeps it. |

## Icon sizes

Icons ([the registry](../icons.md)) are drawn on a 16 px grid, the codicon font's own size. Varia's SVG icons are 1em square, so a rule sizes either kind with `font-size`.

| Token | px | Use | Sized with it |
| --- | --- | --- | --- |
| `--varia-glyph-badge` | 9 | The status mark at a tree icon's corner. | `.oe-icon .oe-badge` |
| `--varia-glyph-sm` | 12 | Glyphs in status bars and tab strips, beside xs and sm text. | `.tab-close .codicon`, `.tab-select .tab-readonly`, `.connection-save-actions .codicon`, `.query-status-state .codicon`, `.memory-indicator .codicon`, `.editor-status .codicon`, `.status-pill > .codicon`, `.status-pill > .icon`, `.chip > .codicon`, `.chip > .icon`, `.live-pill > .codicon`, `.stale-badge > .codicon`, `.tile-caption > .codicon` |
| `--varia-glyph-md` | 16 | Every other icon: tree rows, toolbars, menus, the palette, tabs, dialogs. | `.icon` |
| `--varia-glyph-lg` | 24 | Large glyphs; none today (an empty state draws its glyph at md, as the states kit specifies). |  |

## Bars and rows

Compact is the default and the only density `:root` sets; Comfortable is planned as an option. The title bar (34 px), toolbar controls (28 px), padded buttons and inputs, dock headers (28 px) and grid rows (20 px) keep their own heights until they are moved onto these tokens.

| Token | Compact px | Comfortable px | Planned for | Sized with it now |
| --- | --- | --- | --- | --- |
| `--varia-header` | 40 | 44 | The title bar. | Not yet |
| `--varia-bar` | 36 | 40 | Tab strips, the query bar, side-bar headers. | `.query-tabs`, `.explorer-toolbar` |
| `--varia-control` | 26 | 28 | Buttons, inputs, selects. | `.icon-button`, `.explorer-filter` |
| `--varia-row` | 22 | 26 | Tree, grid and list rows. | `.explorer-row`, `.skeleton-row` |
| `--varia-status` | 24 | 26 | The status bars. | `.status-bar`, `.query-status-bar` |

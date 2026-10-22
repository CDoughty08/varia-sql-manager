# Metric tokens

Generated from `src/shared/theme/metrics.ts` by `npx vitest run tests/theme-metrics.test.ts -u`; do not edit by hand.

Sizes, spacing, radii, shadows, motion and bar heights are CSS custom properties on `:root` in
`src/renderer/src/styles.css`. They are not theme keys: theme files hold colours only, so no theme can resize the
workbench. No UI text is smaller than 11 px; chart axis ticks, drawn on a canvas, are the only exception.

## Type scale

| Size | Line height | px | Use |
| --- | --- | --- | --- |
| `--varia-size-xs` | `--varia-line-xs` | 11 / 16 | Status bars, counts, captions, keys, section labels. |
| `--varia-size-sm` | `--varia-line-sm` | 12 / 16 | Secondary text, buttons, menus, inputs, tree rows, result cells. |
| `--varia-size-md` | `--varia-line-md` | 13 / 20 | Body text and section headings. |
| `--varia-size-lg` | `--varia-line-lg` | 15 / 20 | Document and dialog titles. |
| `--varia-size-xl` | `--varia-line-xl` | 20 / 26 | Headline numbers in live tiles; full-page headings. |

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

One easing curve, `--varia-motion-ease` (`cubic-bezier(0.2, 0, 0, 1)`). Under `prefers-reduced-motion: reduce`, `--varia-motion-fast` and `--varia-motion-base` are 0 ms, and every looping animation stops.

| Token | ms | Use |
| --- | --- | --- |
| `--varia-motion-fast` | 80 | Hover and pressed fills. |
| `--varia-motion-base` | 120 | Menus, popovers and dialogs appearing. |
| `--varia-motion-spin` | 1500 | One turn of a loading spinner (a loop). |
| `--varia-motion-pulse` | 2000 | One beat of the live dot, 0.5 Hz (a loop). |

## Bars and rows

Compact is the default and the only density `:root` sets; Comfortable is planned as an option.

| Token | Compact px | Comfortable px |
| --- | --- | --- |
| `--varia-header` | 40 | 44 |
| `--varia-bar` | 36 | 40 |
| `--varia-control` | 26 | 28 |
| `--varia-row` | 22 | 26 |
| `--varia-status` | 24 | 26 |

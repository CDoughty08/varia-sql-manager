# Color themes

Varia ships two themes, **Varia Dark** (the default) and **Varia Light**, and can follow the operating system. Both use
graphite neutrals and one iris accent; red, amber, and green are kept for state. Custom themes
are small JSON files that override a named palette, individual color keys, and SQL syntax colors on top of the built-in
theme of their type. Key names follow VS Code wherever the concept matches, and palette references work like opencode's.

- [`tokens.md`](tokens.md) lists every palette slot, color key, and SQL scope with its default in both themes.
- [`metrics.md`](metrics.md) lists the type scale, spacing, radii, shadows, motion and bar heights, which themes do not set.
- [`varia-theme.schema.json`](varia-theme.schema.json) is the JSON Schema; editors that understand `$schema` complete and check keys.
- [`examples/`](examples) holds [`harbor.json`](examples/harbor.json), a dual theme using every feature, and
  [`amber-accent.json`](examples/amber-accent.json), the smallest useful theme.

The generated files come from `src/shared/theme/`; do not edit them by hand (see [For contributors](#for-contributors)).

## Choosing a theme

**View ▸ Theme** holds every theme command. On Windows and Linux, open it from the title-bar **View** menu (**Alt+V**); on
macOS, from the menu bar. The command palette (**F1**) has them too, as **Preferences: Color Theme…**, **Preferences: Create
Custom Theme…**, **Preferences: Open Themes Folder**, and **Preferences: Reload Themes**.

| Item | Effect |
| --- | --- |
| **Color Theme…** | A searchable list of the modes and every theme. Each row previews live as it becomes active; Enter chooses it as the menu would, and Escape or clicking elsewhere puts the current theme back. A preview is never saved. |
| **Dark**, **Light**, **Follow System** | The mode. Dark is the default. Native menus follow the mode too; system dialogs such as file pickers follow it on macOS and keep the system appearance on Windows and Linux. |
| **Dark Theme ▸**, **Light Theme ▸** | The theme used in each mode. Choosing from the list opposite a fixed mode switches the mode as well. |
| **Create Custom Theme…** | Writes a starter theme seeded with the current accent colors, selects it, and shows it in the file manager. |
| **Open Themes Folder** | Opens the themes folder, creating it if needed. |
| **Reload Themes** | Reads the folder again. Edits to theme files apply only after a reload. |

Switching applies immediately: queries, undo history, connections, and the panel layout are untouched. The choice is
saved in `appearance.json` in the user-data directory. A dual theme appears in both lists, and choosing it fills both.

### Follow System on Linux

Follow System uses the light or dark preference that Chromium reads from the desktop: the XDG desktop portal's
color-scheme setting where a portal provides it, otherwise a dark GTK theme. A desktop that reports no preference (a bare
X server, for example) counts as light. Varia switches as soon as the desktop announces a change.

## Where themes live

Theme files go in the `themes` folder of Varia's user-data directory. **Open Themes Folder** takes you there; the usual
locations are:

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\varia-sql-manager\themes` |
| macOS | `~/Library/Application Support/varia-sql-manager/themes` |
| Linux | `~/.config/varia-sql-manager/themes` |

- The file name is the theme's id: 1–48 letters, digits, `-` or `_`, ending in `.json`. Ids ignore case, so `Ocean.json`
  and `ocean.json` collide and neither loads. Names starting with `varia-` are reserved for the built-in themes.
- Varia only reads theme files. It never rewrites, renames, or moves them, and it does not follow symbolic links: a link
  (or a folder) with a theme's name is listed as an invalid theme, so copy the theme file itself into the folder.
- **Open Themes Folder** and **Create Custom Theme…** also write `varia-theme.schema.json` into the folder, so a theme
  with `"$schema": "./varia-theme.schema.json"` gets completion offline. The examples use that path, which resolves once a
  file is copied into the folder.

## Quick start

1. Choose **View ▸ Theme ▸ Create Custom Theme…**. Varia writes `custom-theme.json` (or `custom-theme-2.json`, and so
   on) and selects it.
2. Edit the file. For example, change `"accent"`, which the primary button, active tabs, and selected indicators
   follow, and `"focus"` for the focus rings (or set it to `"$accent"`).
3. Choose **View ▸ Theme ▸ Reload Themes**.

This is the whole of [`amber-accent.json`](examples/amber-accent.json):

```json
{ "$schema": "./varia-theme.schema.json", "kind": "varia-color-theme", "version": 1, "name": "Varia Dark (Amber)", "type": "dark",
  "palette": { "accent": "#ffb000", "accentHover": "#ffc54d", "focus": "$accent" } }
```

## File format (version 1)

A theme is a UTF-8 JSON object (a byte-order mark is allowed; comments and trailing commas are not).

| Field | Required | Content |
| --- | --- | --- |
| `kind` | yes | `"varia-color-theme"`. VS Code theme files are not supported yet. |
| `version` | yes | `1`. |
| `name` | yes | Shown in the menu; 1–64 characters. |
| `type` | yes | `"dark"` or `"light"` for one variant, or `"dual"` for both. |
| `description`, `author` | no | Up to 512 and 128 characters. |
| `palette` | no | Palette slots to override or add. |
| `colors` | no | Individual color keys. |
| `tokenColors` | no | SQL syntax rules. |
| `$schema` | no | Ignored by Varia; for editors. |

Any other field is ignored with a warning.

### Layers

A theme is applied on top of the built-in theme of its type: Varia Dark for `dark`, Varia Light for `light`, and both for
`dual`. For each color key Varia uses, in order:

1. the theme's `colors` entry for that key;
2. the key's default, which names a palette slot (or another key) and is evaluated against the built-in palette with the
   theme's `palette` on top.

Because every key defaults to a slot, overriding one slot recolors everything that uses it. Overriding `accent` changes
`button.background`, `tab.activeBorderTop`, `panelTitle.activeBorder`, and every other key that defaults to `$accent`.

### Values

| Value | Meaning |
| --- | --- |
| `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` | A hex color; alpha is optional. |
| `$slot` | A palette slot, built-in or your own. |
| `$slot/pct` | That slot with its opacity multiplied by `pct` percent (0–100), as in `$accent/20`. |
| `{ "dark": …, "light": … }` | **Dual themes only:** a value per variant. A variant you leave out keeps the default. |

Nothing else is accepted: no color names, `rgb()`, `hsl()`, `var()`, or surrounding spaces. Values are at most 40
characters.

### Palette

The 66 built-in slots, with both built-in values, are listed in [`tokens.md`](tokens.md#palette-slots-66). Slots group
the colors that belong together: surfaces (`canvas`, `panel`, `sideBar`, `chrome`, `raised`, `overlay`, `input`),
interaction (`hover`, `active`, `selection`, `selectionStrong`), text tiers (`text` down to `textMuted`), borders,
accents, status colors, glyphs, the six connection colors, five chart series colors (`chart1` to `chart5`, a categorical
set checked for color-vision deficiencies, used only inside charts), and the SQL syntax colors (`syntaxKeyword` and so on).

You can add your own slots, named like `nord0` (a lowercase letter, then up to 31 letters and digits), and refer to them
from other slots, `colors`, and `tokenColors`. A slot may refer to another slot. A chain of more than four references, or a
cycle, is reported; a built-in slot then keeps its built-in value, and a slot of your own is dropped.

### Colors

The 205 keys are listed in [`tokens.md`](tokens.md#color-keys-205) by area: title bar and menus, buttons and inputs,
Object Explorer, the dock, query tabs, the editor, the output panel and results grid, the status bar, banners and
dialogs, and connection colors. Keys marked (VS Code) mean the same as in VS Code; the rest are Varia's own. Some keys
are reserved for upcoming features (notifications, the new Object Explorer and results grid): they resolve now and take
effect when those features ship.

A key that is not in the registry is ignored with a warning. Near misses get a "did you mean" suggestion, and a pasted
block of VS Code keys gets one summary warning.

### SQL syntax

`tokenColors` is a list of rules in the TextMate style VS Code uses:

```json
"tokenColors": [
  { "name": "Keywords", "scope": ["keyword", "storage.type"], "settings": { "foreground": "$accent", "fontStyle": "bold" } },
  { "scope": "comment, comment.quote", "settings": { "foreground": "#7f9f8e", "fontStyle": "italic" } }
]
```

- `scope` is a string (several scopes may be separated by commas) or an array of up to 32 strings.
- Varia has 16 scopes, matching the SQL editor's tokens; [`tokens.md`](tokens.md#sql-syntax-scopes-16) lists them and the
  common TextMate names accepted as aliases, such as `storage.type` for `keyword` and `constant.numeric` for `number`.
  Other scopes are ignored with a warning.
- A sub-scope such as `keyword.block` inherits from `keyword` unless a rule names it.
- `settings.foreground` takes any value above. `settings.fontStyle` is empty or up to four of `italic`, `bold`,
  `underline`, and `strikethrough`, separated by single spaces. Other settings, including `background`, are ignored.
- When several rules name the same scope, later rules win; `foreground` and `fontStyle` override independently. Comments
  are italic by default, so a rule that sets only their `foreground` keeps the italics; `"fontStyle": ""` removes them.
- Brackets are colored by nesting depth, like VS Code's bracket pair colorization, so their color comes from the
  `editorBracketHighlight.*` keys in `colors` rather than from the `delimiter` scopes.

## Problems and fallback

Varia checks every theme it loads. Problems are listed in a banner under the toolbar with the file, the JSON Pointer of
the entry (such as `harbor.json /palette/accent`), and a message.

- **Warnings** (a bad value, an unknown key or scope, a reference that does not resolve) drop only the affected entry,
  which keeps its default. The theme still loads. Warnings are shown when you choose or reload a theme, not at startup.
- **Errors** make the theme unusable: the file cannot be read, is a link or folder, is larger than 128 KiB, is not
  UTF-8 or JSON, is nested too deeply, lacks a valid `kind`, `version`, `name`, or `type`, exceeds a count limit, or has
  a bad, reserved, or duplicate file name.
  The menu shows such themes as "(invalid)" and disabled.
- If the selected theme is missing, unusable, or has no variant for the current mode, Varia shows the built-in theme of
  that type and an alert. The choice is kept, so fixing the file and choosing **Reload Themes** brings it back.

An `appearance.json` that cannot be parsed is set aside as `appearance.json.invalid-<id>.json` and the defaults are used.

## Limits

| Item | Limit |
| --- | --- |
| Theme file size | 128 KiB |
| Nesting depth and values per file | 8 levels, 20,000 values |
| Palette slots, color keys, token rules | 128, 1024, 256 |
| Scopes per rule, scope length | 32, 128 characters |
| Value length | 40 characters |
| `name`, `description`, `author`, `$schema` | 64, 512, 128, 256 characters |
| Reference chain | 4 hops |
| Theme files read | 64, in name order; the rest are skipped with a warning |
| Problems kept | 50 per file, 200 in total |

## Safety

Theme files are untrusted input. Only the main process reads them, through a closed grammar: values are rebuilt from
their numeric channels, so text such as `red;}body{display:none` never reaches the page, and the renderer checks the
result again before applying it. CSS variable names come from Varia's own registry, never from a file. Control and
bidirectional-text characters are removed from names, and the window chrome only ever receives opaque `#rrggbb` colors.

## For contributors

- Colors live only in `src/shared/theme/`: the built-in palettes in `palette.ts` and the keys, their defaults, and the
  SQL scopes in `registry.ts`. CSS and TSX use `var(--varia-<key>)`, with dots in the key replaced by hyphens.
  `tests/theme-css.test.ts` rejects color literals in `styles.css` and renderer components and checks that every CSS key
  is used.
- To add a key, add it to the registry with a default, a description, and its consumers, give text and indicator colors
  a pair in `contrast-pairs.ts`, then regenerate the docs with `npx vitest run tests/theme-schema.test.ts -u`.
- `tests/theme-contrast.test.ts` holds both built-ins to WCAG AA (4.5:1 for text, 3:1 for indicators) on every
  surface each text color is drawn on, Monaco's widgets included, and fails when a `styles.css` rule sets a text color
  and a background without that pair. Disabled text stays exempt (WCAG 1.4.3). `tests/theme-fidelity.test.ts` holds the
  built-ins to the design language: graphite neutrals, one accent hue with status colors far from it, chart colors that
  stay apart for protanopia, deuteranopia and tritanopia and reach 3:1 on the editor, widget and panel backgrounds, NULL
  as muted italics, and a status bar tinted only while a query runs or the backend is down.
- Every key default names a slot or another key; no key has a literal default, so a theme recolors everything,
  the docking compass included.
- Sizes are not theme keys. The type scale (nothing under 11 px), spacing, radii, shadows, motion and bar heights live in
  `metrics.ts`, and `:root` in `styles.css` repeats them as `--varia-size-*`, `--varia-line-*`, `--varia-space-*`,
  `--varia-radius-*`, `--varia-shadow-*` (offset and blur, followed by a color key), `--varia-motion-*`, `--varia-header`,
  `--varia-bar`, `--varia-control`, `--varia-row` and `--varia-status`. `tests/theme-css.test.ts` keeps the two equal and
  apart from the color keys' variables; `tests/theme-metrics.test.ts` rejects px font sizes, radii and shadows and literal
  durations outside the tokens (icon glyphs and 1 px indicator edges excepted) and font-size literals in renderer code,
  keeps the fast transition on `:hover` rules (state rules such as a selected row set `transition: none`), requires every
  looping animation, Monaco's codicon spinners included, to stop under `prefers-reduced-motion: reduce` (which sets the
  transitions to 0 ms), and regenerates [`metrics.md`](metrics.md)
  with `npx vitest run tests/theme-metrics.test.ts -u`. Smoke runs emulate reduced motion in every window, so their
  checks never read a color partway through a transition.
- `scripts/theme-smoke.mjs`, part of `npm run test:smoke`, switches themes in the real app and saves
  `artifacts/theme-dark.png` and `artifacts/theme-light.png`.

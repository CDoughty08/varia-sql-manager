// Fonts are fixed rather than themable, which keeps free-form strings out of theme files. Each stack starts with the
// Windows 11 font, falls back to the Windows 10 one, then covers macOS and Linux.
/** `--varia-font-ui` in styles.css. Windows 11's variable Segoe UI is hinted for 11-13 px text; Windows 10 has only Segoe UI. */
export const uiFontFamily = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, Ubuntu, Cantarell, 'Noto Sans', sans-serif"
/** `--varia-font-mono` in styles.css: results, messages, plan XML, and the connection string preview. Cascadia Mono ships with Windows 11. */
export const monoFontFamily = "'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace"
/** The SQL editor (Monaco takes a font family string, not a CSS variable), with ligatures off (QueryEditor.tsx). */
export const editorFontFamily = "'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace"

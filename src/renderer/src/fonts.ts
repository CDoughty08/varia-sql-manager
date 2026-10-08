// Each stack starts with the font Windows used before, so Windows looks the same; the rest cover macOS and Linux.
// Fonts are fixed rather than themable, which keeps free-form strings out of theme files.
/** `--varia-font-ui` in styles.css. */
export const uiFontFamily = "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, Ubuntu, Cantarell, 'Noto Sans', sans-serif"
/** `--varia-font-mono` in styles.css: results, messages, plan XML, and the connection string preview. */
export const monoFontFamily = "Consolas, 'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace"
/** The SQL editor (Monaco takes a font family string, not a CSS variable). */
export const editorFontFamily = "'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace"

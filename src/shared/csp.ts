/**
 * The workbench page's Content Security Policy. Main sends it as a header on every response, and production builds also
 * carry it as a `<meta>` at the top of index.html (electron.vite.config.ts), so a page loaded from disk keeps it even if
 * the header hook changes. The development server's page needs inline scripts (React refresh) and its own origin and
 * socket; a `<meta>` never applies there. Monaco's and the results grid's workers load from the page's own files.
 */
export function contentSecurityPolicy(developmentUrl?: string): string {
  const connect = developmentUrl ? `${new URL(developmentUrl).origin} ws://127.0.0.1:* ws://localhost:*` : "'self'"
  return `default-src 'self'; script-src 'self'${developmentUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src ${connect}; object-src 'none'; frame-src 'none'; base-uri 'none'`
}

/** The most placeholder rows a view draws; a first load needs a hint, not a page of bars. */
export const maxSkeletonRows = 12

/**
 * Placeholder rows for a first load. CSS holds them back for --varia-motion-delay (300 ms), so a quick load never
 * flashes them, and keeps them still: the only motion is their fade in, which reduced motion removes.
 */
export default function Skeleton({ rows = 3, label = 'Loading' }: { readonly rows?: number; readonly label?: string }) {
  const count = Math.min(maxSkeletonRows, Math.max(1, Math.floor(rows)))
  return <div className="skeleton" role="status">
    <span className="visually-hidden">{label}…</span>
    {Array.from({ length: count }, (_, index) => <div key={index} className="skeleton-row" aria-hidden="true" />)}
  </div>
}

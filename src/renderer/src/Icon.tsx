const paths = {
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M5 3l5 5-5 5',
  folder: 'M2 4h5l2 2h5v7H2ZM2 4V3h5l2 2h5v1',
  login: 'M10.5 4a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM3 14v-2a5 4 0 0 1 10 0v2',
  role: 'M8.5 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM2 13v-2a4.5 4 0 0 1 9 0v2M11 2a2 2 0 0 1 0 4M12 8a3 3 0 0 1 2 3v2',
  key: 'M7 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM7 6h7M11 6v3M14 6v2',
  shield: 'M8 1l6 2v4c0 4-6 7-6 7S2 11 2 7V3ZM5 7l2 2 4-4',
  database: 'M13 4c0 1.1-2.2 2-5 2S3 5.1 3 4s2.2-2 5-2 5 .9 5 2ZM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  table: 'M2 3h12v10H2ZM2 6h12M6 6v7M10 6v7',
  server: 'M2 2h12v5H2ZM2 9h12v5H2ZM4 4.5h1M4 11.5h1',
  play: 'M5 3l8 5-8 5Z',
  stop: 'M4 4h8v8H4Z',
  open: 'M2 5V3h5l2 2h5v8H2ZM2 7h12',
  save: 'M2 2h10l2 2v10H2ZM5 2v4h6V2M5 14V9h6v5',
  layout: 'M2 2h12v12H2ZM6 2v12M6 9h8',
  refresh: 'M13 6a5 5 0 1 0 .2 3M13 2v4H9',
  disconnect: 'M5 2v3M11 2v3M3 5h10v3a5 5 0 0 1-5 5v2M2 2l12 12'
} as const

export default function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

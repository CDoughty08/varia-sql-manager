import type { CommandId } from '../commands/catalog'
import type { GestureId } from '../commands/gestures'
import type { SettingKey } from '../settings/catalog'

export type LessonContext = 'workbench' | 'queryEditor' | 'resultsGrid'
export interface GuideMetadata {
  readonly title: string
  readonly summary: string
  readonly keywords: readonly string[]
  readonly sections: readonly { readonly id: string; readonly title: string }[]
  readonly related: readonly string[]
  readonly commands: readonly { readonly id: CommandId; readonly context: LessonContext }[]
  readonly settings: readonly SettingKey[]
  readonly gestures: readonly GestureId[]
  /** Advisory documentation-impact map; not every code change requires a prose edit. */
  readonly sourceAreas: readonly string[]
}

/** One registration per page. Its lazy component has the same file name in renderer/help/guides. */
export const guideCatalog = {
  connect: {
    title: 'Connect to SQL Server', summary: 'Choose a server and sign-in method, then find your databases.',
    keywords: ['connection', 'authentication', 'login', 'password', 'Entra', 'TLS'],
    sections: [{ id: 'prepare', title: 'Before you connect' }, { id: 'sign-in', title: 'Choose your sign-in' }, { id: 'next', title: 'Connect and explore' }, { id: 'trouble', title: 'If connecting fails' }],
    related: ['run-query'], commands: [{ id: 'connection.connect', context: 'workbench' }], settings: ['environment.connections.autoReconnect'], gestures: [],
    sourceAreas: ['src/renderer/src/ConnectDialog.tsx', 'src/shared/auth.ts', 'src/renderer/src/services/startup-reconnect.ts']
  },
  'run-query': {
    title: 'Run your first query', summary: 'Create a query, choose its database and understand what Execute runs.',
    keywords: ['SQL', 'selection', 'execute', 'editor', 'messages', 'cancel'],
    sections: [{ id: 'new', title: 'Open a query' }, { id: 'execute', title: 'Choose what runs' }, { id: 'read', title: 'Read the outcome' }],
    related: ['connect', 'results'], commands: [{ id: 'file.new', context: 'workbench' }, { id: 'query.execute', context: 'queryEditor' }], settings: [], gestures: [],
    sourceAreas: ['src/renderer/src/contributions/query.ts', 'src/renderer/src/services/queries.ts', 'src/renderer/src/services/targets.ts', 'src/renderer/src/services/session.ts']
  },
  results: {
    title: 'Work with query results', summary: 'Sort and filter returned rows, select cells and copy with confidence.',
    keywords: ['grid', 'copy', 'headers', 'sort', 'filter', 'selection'],
    sections: [{ id: 'browse', title: 'Explore returned rows' }, { id: 'select', title: 'Select and copy' }, { id: 'limits', title: 'Know the limits' }],
    related: ['run-query'], commands: [{ id: 'output.copy', context: 'resultsGrid' }, { id: 'output.copyWithHeaders', context: 'resultsGrid' }],
    settings: ['queryResults.grid.includeColumnHeaders'], gestures: ['grid.addToSelection'],
    sourceAreas: ['src/renderer/src/results', 'src/shared/settings/query-results.ts']
  }
} as const satisfies Record<string, GuideMetadata>
export type GuideId = keyof typeof guideCatalog
export const guideIds = Object.keys(guideCatalog) as GuideId[]
export const isGuideId = (id: unknown): id is GuideId => typeof id === 'string' && Object.hasOwn(guideCatalog, id)
export const guideMetadata = (id: GuideId): GuideMetadata => guideCatalog[id]
export const matchingGuides = (search: string): readonly GuideId[] => {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return guideIds.filter(id => {
    const guide = guideMetadata(id), text = [guide.title, guide.summary, ...guide.keywords].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}

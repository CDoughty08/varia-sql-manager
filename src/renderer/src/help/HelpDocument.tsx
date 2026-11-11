import { Component, lazy, Suspense, useLayoutEffect, type ComponentType, type ReactNode } from 'react'
import { guideIds, guideMetadata, matchingGuides } from '../../../shared/help/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import { GuideLinks } from './GuidePage'
import { helpRouteKey } from './HelpService'

export interface GuideProps { readonly documentId: string }
export const guideLoaders = import.meta.glob<{ default: ComponentType<GuideProps> }>('./guides/*.tsx')
const pages = new Map(guideIds.map(id => [id, lazy(() => {
  const load = guideLoaders[`./guides/${id}.tsx`]
  return load ? load() : Promise.reject(new Error('Guide module missing.'))
})] as const))

class GuideBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div className="document-content" role="alert"><EmptyState icon="info" title="This guide could not be opened" detail="Choose All guides to return to the list. If the problem continues, restart Varia." /></div> : this.props.children
  }
}

export default function HelpDocument({ documentId }: GuideProps) {
  const { help } = useWorkbench(), { route, search } = useServiceSnapshot(help)
  useLayoutEffect(() => help.mounted(documentId), [help, documentId])
  if (route.kind === 'guide') {
    const Page = pages.get(route.id)!, guide = guideMetadata(route.id)
    // Only the body suspends: navigation owns focus once, and the same header survives loading and failure.
    return <DocumentFrame key={helpRouteKey(route)} id={documentId} title={guide.title} subtitle="Getting Started"
      attributes={{ 'data-help-document': documentId, 'data-help-guide': route.id }}
      tools={<button type="button" data-help-focus onClick={() => help.open()}>All guides</button>}
      banner={<div className="help-intro"><p>{guide.summary}</p><p className="help-muted">Shortcuts, gestures and option values follow settings currently applied in this window. Keys below describe the named workspace context; sample controls use only fictional data.</p></div>}
      body={<GuideBoundary><Suspense fallback={<div className="document-content" role="status"><EmptyState icon="info" title="Opening guide…" detail="Loading the bundled page." /></div>}><Page documentId={documentId} /></Suspense></GuideBoundary>} />
  }
  const matches = matchingGuides(search)
  return <DocumentFrame id={documentId} title="Getting Started" subtitle="Learn Varia" attributes={{ 'data-help-document': documentId }}>
    {route.kind === 'missing' ? <EmptyState icon="info" title="This guide is not available" detail="This copy of Varia does not include the requested guide."
      actions={[{ label: 'All guides', run: () => help.open() }]} /> : <div className="help-home">
      <div className="help-intro"><h2>A clear path from connection to results</h2><p>Start with a server you can access. Learn one workflow at a time, with examples you can explore safely here.</p></div>
      <label className="help-search">Find a guide<input type="search" data-help-focus aria-label="Find a guide" value={search} maxLength={200} placeholder="Try connection, selection or copy" onChange={event => help.search(event.target.value)} /></label>
      <p className="help-muted" role="status">{matches.length} of {guideIds.length} guides</p>
      {matches.length ? <GuideLinks ids={matches} /> : <EmptyState icon="search" title="No guides match" detail="Try a shorter search or clear the filter." actions={[{ label: 'Clear search', run: () => help.search('') }]} />}
      <p className="help-muted">Available offline. Guides describe this build. Examples use fictional data; nothing here connects or runs SQL automatically.</p>
    </div>}
  </DocumentFrame>
}

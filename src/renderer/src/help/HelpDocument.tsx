import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { guideIds, matchingGuides } from '../../../shared/help/catalog'
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

class GuideBoundary extends Component<{ readonly children: ReactNode; readonly home: () => void }, { readonly failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <EmptyState icon="info" title="This guide could not be opened" detail="Return to the guide list. If the problem continues, restart Varia."
      actions={[{ label: 'All guides', run: this.props.home }]} /> : this.props.children
  }
}

export default function HelpDocument({ documentId }: GuideProps) {
  const { help } = useWorkbench(), { route, search } = useServiceSnapshot(help)
  if (route.kind === 'guide') {
    const Page = pages.get(route.id)!
    return <GuideBoundary key={helpRouteKey(route)} home={() => help.open()}><Suspense fallback={<EmptyState icon="info" title="Opening guide…" detail="Loading the bundled page." />}><Page documentId={documentId} /></Suspense></GuideBoundary>
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

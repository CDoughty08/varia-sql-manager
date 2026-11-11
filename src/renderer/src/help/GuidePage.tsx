import { useEffect, type ReactNode } from 'react'
import { guideCatalog, guideMetadata, isGuideId, type GuideId } from '../../../shared/help/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame from '../kit/DocumentFrame'

export function GuideLinks({ ids }: { readonly ids: readonly GuideId[] }) {
  const { commands } = useWorkbench()
  return <div className="help-cards">{ids.map(id => {
    const guide = guideMetadata(id)
    return <button type="button" className="help-card" key={id} onClick={() => { void commands.execute('help.openGuide', { guideId: id }, 'toolbar') }}>
      <strong>{guide.title}</strong><span>{guide.summary}</span><span className="help-card-open">Read guide</span>
    </button>
  })}</div>
}

type GuideContent<Id extends GuideId> = Readonly<Record<typeof guideCatalog[Id]['sections'][number]['id'], ReactNode>>
export default function GuidePage<Id extends GuideId>({ id, documentId, content }: { readonly id: Id; readonly documentId: string; readonly content: GuideContent<NoInfer<Id>> }) {
  const { help } = useWorkbench(), { frame, route } = useServiceSnapshot(help), guide = guideMetadata(id)
  useEffect(() => help.ready(documentId), [help, documentId])
  return <DocumentFrame id={documentId} title={guide.title} subtitle="Getting Started"
    attributes={{ 'data-help-document': documentId, 'data-help-guide': id }}
    tools={<button type="button" data-help-focus onClick={() => help.open()}>All guides</button>}
    banner={<div className="help-intro"><p>{guide.summary}</p><p className="help-muted">Shortcuts, gestures and option values follow settings currently applied in this window. Keys below describe the named workspace context; sample controls use only fictional data.</p></div>}
    sections={[...guide.sections.map(section => ({ ...section, content: <div className="help-prose">{(content as Readonly<Record<string, ReactNode>>)[section.id]}</div> })), { id: 'related', title: 'Continue learning', content: <GuideLinks ids={guide.related.filter(isGuideId)} /> }]}
    frame={frame} onFrame={next => help.setFrame(route, next)} />
}

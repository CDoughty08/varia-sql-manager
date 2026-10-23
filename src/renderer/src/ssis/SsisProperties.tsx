import { displayText } from '../../../shared/explorer/refs.ts'
import { ssisDocumentSpecs } from '../../../shared/ssis/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame, { type Verb } from '../kit/DocumentFrame'
import InlineError, { type ErrorAction } from '../kit/InlineError'
import { StaleBadge } from '../kit/LivePill'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import { ssisCrumbs, ssisFacts, ssisHeaderState, ssisSectionViews, truncatedNote } from './properties-view'
import type { SsisPropertiesState } from './SsisPropertiesService'

/** The DOM id prefix of a document's frame. */
export const ssisFrameId = (documentId: string) => `ssis-${documentId}`

/**
 * An SSIS Catalog object's properties as a document (Folder, Project, Package or Environment Properties): the path to it,
 * its name, its state and Refresh, then its sections. Read-only; the model stays on screen while Refresh reads, and after
 * a failure, with the failure above it.
 */
export default function SsisProperties({ documentId }: { readonly documentId: string }) {
  const { ssisProperties: service, commands } = useWorkbench()
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  if (!state) return null
  const spec = ssisDocumentSpecs[state.kind], title = state.model?.name ?? state.target.name ?? ''
  const verbs: Verb[] = [{ command: 'ssis.refreshProperties', args: { tabId: documentId }, label: 'Refresh' }]
  const header = ssisHeaderState(state)
  const stateView = header?.kind === 'pill' ? <StatusPill tone={header.tone} label={header.label} title={header.title} /> : header?.kind === 'stale' ? <StaleBadge updatedAt={header.since} stale={{ since: header.since }} /> : header ? <StaleBadge updatedAt={header.at} /> : undefined
  const close = { label: 'Close', run: () => void commands.execute('file.close', { tabId: documentId }, 'toolbar') }
  const notice = hasNotice(state) ? <SsisNotice state={state} close={close} retry={() => service.refresh(documentId)} /> : undefined
  const sections = ssisSectionViews(state)
  return <DocumentFrame id={ssisFrameId(documentId)} title={displayText(title)} subtitle={spec.title} crumbs={ssisCrumbs(state)} state={stateView} verbs={verbs} facts={ssisFacts(state.model)}
    notice={state.model ? notice : undefined} attributes={{ 'data-ssis-document': documentId }}
    {...sections.length ? { sections, frame: state.frame, onFrame: frame => service.setFrame(documentId, frame) } : {}}>
    {state.loading ? <Skeleton rows={6} label={`Reading the ${spec.noun}`} /> : notice}
  </DocumentFrame>
}

const hasNotice = (state: SsisPropertiesState) => !!state.error || state.disconnected || truncatedNote(state) !== undefined

/**
 * What the document has to say above its content: why the last read failed, that it cannot read now, or that lists stop
 * short. Retry is offered only when a read could start: while one runs it would do nothing.
 */
export function SsisNotice({ state, close, retry }: { readonly state: SsisPropertiesState; readonly close: ErrorAction; readonly retry: () => void }) {
  const { error } = state, note = truncatedNote(state)
  const actions: ErrorAction[] = state.gone ? [close] : error?.retryable && !state.disconnected && !state.loading ? [{ label: 'Retry', run: retry }] : []
  return <>
    {error && <InlineError message={error.message} code={error.code} details={error.details} context={`Reading ${ssisDocumentSpecs[state.kind].title} on ${state.serverLabel}`} actions={actions} />}
    {state.disconnected && !state.gone && <p className="ssis-properties-note" role="status">{state.serverLabel} is not connected. Connect to it again to refresh these properties.</p>}
    {note && <p className="ssis-properties-note">{note}</p>}
  </>
}

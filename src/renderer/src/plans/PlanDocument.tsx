import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import PlanViewer from './PlanViewer'
import { locateXml, targetAtXmlOffset, type PlanXmlTarget } from './navigation'

/** Keep the original text model for Save, recovery and an editable XML source view. */
export default function PlanDocument({ documentId, source, onSource }: { documentId: string; source: boolean; onSource(value: boolean): void }) {
  const { documents, planPreparation } = useWorkbench()
  const model = documents.getModel(documentId)
  const [xmlTarget, setXmlTarget] = useState(() => planPreparation.takeXml(documentId))
  const [navigation, setNavigation] = useState<PlanXmlTarget>()
  const graphTarget = useRef<PlanXmlTarget | undefined>(undefined)
  const [version, setVersion] = useState<number | undefined>(() => documents.isFilling(documentId) ? undefined : model?.getVersionId() ?? 0)
  useEffect(() => { if (xmlTarget) onSource(true) }, [])
  useLayoutEffect(() => {
    if (!source || !xmlTarget || !model || version === undefined || documents.isFilling(documentId) || xmlTarget.revision !== undefined && xmlTarget.revision !== model.getVersionId()) return
    const location = locateXml(model.getValue(), xmlTarget), editor = documents.editorOf(documentId)
    if (!location || !editor) return
    const start = model.getPositionAt(location.start), end = model.getPositionAt(location.openEnd)
    const range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
    editor.setSelection(range); editor.revealRangeInCenter(range); editor.focus()
    setXmlTarget(undefined)
  }, [source, xmlTarget, version, model, documents, documentId])
  useEffect(() => {
    if (model) planPreparation.watchDocument(documentId, changed => model.onDidChangeContent(changed))
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = model?.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(() => { if (!documents.isFilling(documentId)) setVersion(model.getVersionId()) }, 150) })
    if (model && !documents.isFilling(documentId)) setVersion(model.getVersionId())
    return () => { clearTimeout(timer); changed?.dispose() }
  }, [documents, documentId, model, planPreparation])
  const sources = useMemo(() => version === undefined ? [] : [{ key: documentId, revision: version, label: 'Execution plan', read: async () => model?.getValue() ?? '' }], [documentId, model, version])
  return <>
    <div className="plan-document-tools" role="group" aria-label="Execution plan document views">
      <button type="button" aria-pressed={!source} disabled={version === undefined || documents.isFilling(documentId)} onClick={() => {
        if (source && model) {
          const editor = documents.editorOf(documentId), selection = editor?.getSelection()
          const position = selection && !selection.isEmpty() ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : editor?.getPosition()
          setNavigation(position ? targetAtXmlOffset(model.getValue(), model.getOffsetAt(position)) : undefined)
        }
        if (!documents.isFilling(documentId)) setVersion(model?.getVersionId() ?? 0); onSource(false)
      }}>Graph</button>
      <button type="button" aria-pressed={source} onClick={() => { if (!source) setXmlTarget(graphTarget.current); onSource(true) }}>XML source</button>
    </div>
    {!source && <PlanViewer key={documentId} sources={sources} identity={'document:' + documentId} scope={documentId} navigation={navigation} onXmlTargetChanged={target => { graphTarget.current = target }}
      navigateXml={target => { setXmlTarget(target); onSource(true) }} />}
  </>
}

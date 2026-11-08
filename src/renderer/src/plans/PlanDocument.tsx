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
  const sourceEntry = useRef<{ offset: number; revision: number } | undefined>(undefined)
  const preserveXml = useRef(false)
  const xmlPosition = () => {
    const editor = documents.editorOf(documentId), selection = editor?.getSelection()
    const position = selection && !selection.isEmpty() ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : editor?.getPosition()
    return model && position ? { offset: model.getOffsetAt(position), revision: model.getVersionId() } : undefined
  }
  const [version, setVersion] = useState<number | undefined>(() => documents.isFilling(documentId) ? undefined : model?.getVersionId() ?? 0)
  useEffect(() => { if (xmlTarget) onSource(true) }, [])
  useEffect(() => { if (source && preserveXml.current && !sourceEntry.current) sourceEntry.current = xmlPosition() }, [source])
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
          const position = xmlPosition(), previous = preserveXml.current ? sourceEntry.current : undefined
          // A view switch preserves independent editor and graph positions. Moving the XML caret,
          // editing XML, or explicitly navigating to XML supplies a new graph target.
          const moved = !previous || position?.offset !== previous.offset || position?.revision !== previous.revision
          setNavigation(moved && position ? targetAtXmlOffset(model.getValue(), position.offset) : undefined)
        }
        if (!documents.isFilling(documentId)) setVersion(model?.getVersionId() ?? 0); onSource(false)
      }}>Graph</button>
      <button type="button" aria-pressed={source} onClick={() => {
        if (!source) { preserveXml.current = true; sourceEntry.current = xmlPosition() }
        onSource(true)
      }}>XML source</button>
    </div>
    {!source && <PlanViewer key={documentId} sources={sources} identity={'document:' + documentId} scope={documentId} xmlNavigation={navigation}
      navigateXml={target => { preserveXml.current = false; sourceEntry.current = undefined; setXmlTarget(target); onSource(true) }} />}
  </>
}

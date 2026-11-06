import { useEffect, useMemo, useState } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import PlanViewer from './PlanViewer'

/** Keep the original text model for Save, recovery and an editable XML source view. */
export default function PlanDocument({ documentId, source, onSource }: { documentId: string; source: boolean; onSource(value: boolean): void }) {
  const { documents } = useWorkbench()
  const model = documents.getModel(documentId)
  const [version, setVersion] = useState<number | undefined>(() => documents.isFilling(documentId) ? undefined : model?.getVersionId() ?? 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = model?.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(() => { if (!documents.isFilling(documentId)) setVersion(model.getVersionId()) }, 150) })
    return () => { clearTimeout(timer); changed?.dispose() }
  }, [documents, documentId, model])
  const sources = useMemo(() => version === undefined ? [] : [{ key: documentId, revision: version, label: 'Execution plan', read: async () => model?.getValue() ?? '' }], [documentId, model, version])
  return <>
    <div className="plan-document-tools" role="group" aria-label="Execution plan document views">
      <button type="button" aria-pressed={!source} onClick={() => onSource(false)}>Graph</button>
      <button type="button" aria-pressed={source} onClick={() => onSource(true)}>XML source</button>
    </div>
    {!source && <PlanViewer key={documentId} sources={sources} identity={'document:' + documentId} />}
  </>
}

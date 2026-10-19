import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { memoryWarning } from './memory'
import { formatBytes } from './status'

/** The status bar's "Results 12 MB / 512 MB": what the backend holds for results, hidden while it holds nothing. */
export default function MemoryIndicator() {
  const memory = useServiceSnapshot(useWorkbench().resultMemory)
  if (memory.usedBytes <= 0) return null
  const used = formatBytes(memory.usedBytes), budget = formatBytes(memory.globalBytes), warning = memoryWarning(memory)
  const title = `Query results held by the SQL backend: ${used} of a ${budget} budget. Close results or query tabs to free memory.${warning ? ' When it is full, new results are truncated.' : ''}`
  // The warning icon is drawn; the hidden words say it, and what follows when memory runs out.
  return <span className={`memory-indicator${warning ? ' warning' : ''}`} title={title}>
    {warning && <><span className="codicon codicon-warning" aria-hidden="true" /><span className="visually-hidden">Warning: </span></>}Results {used} / {budget}
    {warning && <span className="visually-hidden">. When it is full, new results are truncated.</span>}
  </span>
}

import { memo, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { MessageEntry } from '../../../shared/contracts'
import type { TabResults } from './ResultsService'
import { useWorkbench } from '../core/WorkbenchContext'
import type { Workbench } from '../core/workbench'
import Icon from '../Icon'

/** One message as SSMS prints it; errors in red. Entries never change once shown, so each renders once. */
const Message = memo(function Message({ entry, tabId, queryId, index, canReveal, commands, gestures }: {
  entry: MessageEntry; tabId: string; queryId: string; index: number; canReveal: boolean
} & Pick<Workbench, 'commands' | 'gestures'>) {
  const args = entry.line === undefined ? undefined : { tabId, message: { queryId, index, line: entry.line } }
  const reveal = () => { if (canReveal) void commands.execute('output.revealError', args, 'toolbar') }
  return <div className="message-entry" onDoubleClick={event => {
    if (!(event.target as Element).closest('button') && gestures.matches('messages.revealError', event)) reveal()
  }}>
    <pre className={entry.kind === 'error' ? 'msg error' : 'msg'}>{entry.text}</pre>
    {entry.kind === 'error' && entry.line !== undefined && <button type="button" className="message-source-link" disabled={!canReveal}
      title={canReveal ? `Go to line ${entry.line}` : 'The query text has changed since execution, or this source is no longer open.'} onClick={reveal}>
      <Icon name="go-to-file" /><span>Go to line {entry.line}</span>
    </button>}
  </div>
})

/** What Messages show after the last message: SSMS's line when SQL Server sent nothing (Varia's own notices do not
 *  count), then the completion time. */
export function messageTail(tab: Pick<TabResults, 'status' | 'messages' | 'notices' | 'summary'>): string[] {
  if (tab.status === 'running') return []
  const lines = tab.messages.length - tab.notices === 0 && (tab.status === 'completed' || tab.status === 'closed') ? ['Commands completed successfully.'] : []
  if (tab.summary?.completedAt) lines.push('', 'Completion time: ' + tab.summary.completedAt)
  return lines
}

/**
 * The Messages view, and the Messages strip's open part: messages stream in as the script runs, SQL errors inline in SSMS's two-line form and in red, then
 * the tail. It stays scrolled to the bottom while it was at the bottom; the strip (`firstError`) shows the first error at its
 * top instead, once, when there is one. Text is selectable; Ctrl+A (output.selectAll, under messagesFocus) selects only it.
 */
export default function MessagesView({ id, tabId, tab, firstError }: { id?: string; tabId: string; tab: TabResults; firstError?: boolean }) {
  const { commands, documents, queries, gestures } = useWorkbench()
  const subscribe = useCallback((listener: () => void) => {
    const content = documents.getModel(tabId)?.onDidChangeContent(listener), changed = documents.subscribe(listener)
    return () => { content?.dispose(); changed() }
  }, [documents, tabId])
  const revision = () => documents.revision(tabId)
  useSyncExternalStore(subscribe, revision, revision)
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const shownError = useRef(-1)
  const tail = messageTail(tab)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const error = firstError ? tab.messages.findIndex(entry => entry.kind === 'error') : -1
    if (error >= 0) {
      if (shownError.current === error) return
      shownError.current = error
      const line = element.children[error]
      if (line) element.scrollTop += line.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop
      return
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight
  }, [tab.messages, tail.length, firstError])
  return <div ref={ref} id={id} className="messages" role="log" aria-label="Messages" tabIndex={0} data-output-view="messages" data-tab-id={tabId} data-result-index={0} data-pane-focus="messages"
    onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 4 }}>
    {tab.messages.map((entry, index) => <Message key={index} entry={entry} index={index} tabId={tabId} queryId={tab.queryId} commands={commands} gestures={gestures}
      canReveal={entry.kind === 'error' && queries.sourceLine(tabId, tab.queryId, entry.line) !== undefined} />)}
    {tail.map((line, index) => <pre key={'tail' + index} className="msg">{line || ' '}</pre>)}
  </div>
}

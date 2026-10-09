import { memo, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import type { MessageEntry } from '../../../shared/contracts'
import { chordFromEvent } from '../../../shared/commands/keybindings'
import { useWorkbench } from '../core/WorkbenchContext'
import type { TabResults } from './ResultsService'

/** One message as SSMS prints it; errors in red. Entries never change once shown, so each renders once. */
const Message = memo(function Message({ entry }: { entry: MessageEntry }) {
  return <pre className={entry.kind === 'error' ? 'msg error' : 'msg'}>{entry.text}</pre>
})

/** What Messages show after the last message: SSMS's line when there was nothing else, then the completion time. */
export function messageTail(tab: Pick<TabResults, 'status' | 'messages' | 'summary'>): string[] {
  if (tab.status === 'running') return []
  const lines = tab.messages.length === 0 && (tab.status === 'completed' || tab.status === 'closed') ? ['Commands completed successfully.'] : []
  if (tab.summary?.completedAt) lines.push('', 'Completion time: ' + tab.summary.completedAt)
  return lines
}

/**
 * The Messages tab: messages stream in as the script runs, SQL errors inline in SSMS's two-line form and in red, then
 * the tail. It stays scrolled to the bottom while it was at the bottom. Text is selectable; Ctrl+A selects only it.
 */
export default function MessagesView({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { platform } = useWorkbench()
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const tail = messageTail(tab)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && atBottom.current) element.scrollTop = element.scrollHeight
  }, [tab.messages, tail.length])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (chordFromEvent(event.nativeEvent, platform) !== (platform === 'darwin' ? 'meta+a' : 'ctrl+a')) return
    event.preventDefault()
    event.currentTarget.ownerDocument.getSelection()?.selectAllChildren(event.currentTarget)
  }
  return <div ref={ref} className="messages" role="log" aria-label="Messages" tabIndex={0} data-output-view="messages" data-tab-id={tabId} data-result-index={0} data-pane-focus="messages"
    onKeyDown={keyDown} onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 4 }}>
    {tab.messages.map((entry, index) => <Message key={index} entry={entry} />)}
    {tail.map((line, index) => <pre key={'tail' + index} className="msg">{line || ' '}</pre>)}
  </div>
}

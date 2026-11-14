import { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { focusToReturn, returnFocusTo } from '../core/focus'
import { trapFocus } from '../trap-focus'
import type { DisconnectChoice, DisconnectPrompt, DisconnectPromptService } from './DisconnectPromptService'

/** Mount once in the main window; the shared service also accepts commands from popouts. */
export default function DisconnectDialog({ service }: { readonly service: DisconnectPromptService }) {
  const prompt = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  return prompt ? <Prompt prompt={prompt} answer={choice => service.answer(prompt.promptId, choice)} /> : null
}

function Prompt({ prompt, answer }: { readonly prompt: DisconnectPrompt; readonly answer: (choice: DisconnectChoice) => void }) {
  const titleId = useId(), descriptionId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  const origin = useRef(focusToReturn())
  useEffect(() => { cancel.current?.focus() }, [prompt.promptId])
  useEffect(() => () => returnFocusTo(origin.current), [])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); answer('cancel') }
    // Enter on explanatory text is safe too; a focused button retains its ordinary activation behavior.
    else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); answer('cancel') }
  }
  const running = prompt.tabs.some(tab => tab.running)
  return createPortal(<div className="modal-backdrop"><div className="connection-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id={titleId}>Disconnect {prompt.name}?</h2></div>
    <div className="connection-scroll" id={descriptionId}>
      <p>These query tabs use this connection:</p>
      <ul aria-label="Affected query tabs">{prompt.tabs.map(tab => <li key={tab.id}>{tab.name}{tab.dirty ? ' — unsaved changes' : ''}{tab.running ? ' — running' : ''}</li>)}</ul>
      <p>Keep Tabs retains query text, unsaved changes, each tab’s database, connection target and completed results. Retained results belong to the previous SQL session.</p>
      <p>Close Query Tabs asks about every unsaved query before closing any tabs. Custom-document drafts stay open.</p>
      <p>Open transactions are checked and require a separate choice before disconnecting. Transactions are never committed automatically.</p>
      {running && <p>Disconnecting cancels the running queries after confirmation. Cancellation may leave the outcome unknown; completed statements may already have taken effect.</p>}
      <p>Cancel keeps the connection and all tabs. Files explicitly saved during review may remain saved.</p>
    </div>
    <div className="connection-footer" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button type="button" onClick={() => answer('keep-tabs')}>Disconnect and Keep Tabs</button>
      <button type="button" onClick={() => answer('close-query-tabs')}>Disconnect and Close Query Tabs</button>
      <button type="button" ref={cancel} onClick={() => answer('cancel')}>Cancel</button>
    </div>
  </div></div>, document.body)
}

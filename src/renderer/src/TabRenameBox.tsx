import { useEffect, useRef, type KeyboardEvent } from 'react'
import { tabNameChars } from '../../shared/files/session'
import type { TabRenameService } from './services/tab-rename'

/**
 * The text box Rename Tab puts in a tab's place in the strip, holding its name selected. Enter keeps the name and Escape
 * the old one, both returning focus to the tab; focus leaving the box keeps it too. An empty name takes the rename away.
 */
export default function TabRenameBox({ tabId, name, service }: { readonly tabId: string; readonly name: string; readonly service: TabRenameService }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  // The tab is Dockview's tab element in the document's editor group.
  const refocus = (source: HTMLInputElement) => {
    const owner = source.ownerDocument
    requestAnimationFrame(() => {
      const tab = owner.querySelector<HTMLElement>(`.dv-tab[data-tab-panel-id="${CSS.escape(tabId)}"]`), active = owner.activeElement
      // The inline box unmounts onto body. A tab, menu or another rename focused meanwhile owns the keyboard now.
      if (active !== source && active !== owner.body && active !== tab) return
      tab?.focus()
    })
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); service.commit(tabId, event.currentTarget.value); refocus(event.currentTarget) }
    else if (event.key === 'Escape') { event.preventDefault(); service.cancel(); refocus(event.currentTarget) }
  }
  return <input ref={input} className="tab-rename" type="text" aria-label="Tab name" defaultValue={name} maxLength={tabNameChars} spellCheck={false} data-document-tab
    onKeyDown={key} onBlur={event => service.commit(tabId, event.currentTarget.value)} onMouseDown={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation() }} />
}

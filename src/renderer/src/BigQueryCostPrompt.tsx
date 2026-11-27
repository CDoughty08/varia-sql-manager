import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { focusToReturn, returnFocusTo } from './core/focus'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import SubDialog from './dialogs/SubDialog'
import EnvironmentTag from './EnvironmentTag'
import type { CostPromptRequest } from './services/bigquery-cost'
import { costPromptText, multiCostPromptText, promptTurnLockFor, type MultiProjectCostPromptRequest } from './services/bigquery-cost-prompt'

type ActiveCostPrompt =
  | { readonly kind: 'single'; readonly id: number; readonly request: CostPromptRequest }
  | { readonly kind: 'multi'; readonly id: number; readonly request: MultiProjectCostPromptRequest }

function focusCandidate(): HTMLElement | null {
  const candidate = focusToReturn()
  return candidate && candidate !== candidate.ownerDocument.body && !candidate.closest('[aria-modal="true"]') ? candidate : null
}

/**
 * Execute's cost prompt for a BigQuery query (docs/bigquery.md, Cost): above the threshold, or when the estimate may be
 * low. Supports both single-project prompts and aggregated multi-project Cross-Engine prompts so multiple projects never
 * stack N sequential modals. Opens with focus on Cancel and is announced as an alert dialog; Cost settings… opens Tools › Options there.
 */
export default function BigQueryCostPrompt() {
  const { costPrompts } = useWorkbench()
  const { pending, pendingMulti } = useServiceSnapshot(costPrompts)
  const turnLock = promptTurnLockFor(costPrompts)
  const turnOwner = useServiceSnapshot(turnLock)
  const active: ActiveCostPrompt | undefined = pending
    ? { kind: 'single', id: pending.id, request: pending.request }
    : pendingMulti
      ? { kind: 'multi', id: pendingMulti.id, request: pendingMulti.request }
      : undefined
  const hasPending = !!active
  const isOpen = hasPending && turnOwner === 'cost'
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (isOpen && !wasOpen.current) {
    // Ignore elements inside a closing modal (e.g. MultiExecuteDialog unmounting in the same render);
    // ActivePrompt re-captures focus via onBeforeInitialFocus once the closing modal's cleanup restores it.
    returnFocus.current = focusCandidate()
  }
  wasOpen.current = isOpen

  useEffect(() => {
    if (!isOpen) return
    return () => {
      const target = returnFocus.current
      returnFocus.current = null
      returnFocusTo(target)
    }
  }, [isOpen])

  // Declared after returnFocus cleanup so focus returns to the underlying surface before handing the turn to a waiting peer.
  useEffect(() => {
    if (hasPending) {
      turnLock.claim('cost')
      return () => { turnLock.release('cost') }
    }
    turnLock.release('cost')
    return undefined
  }, [turnLock, hasPending])

  if (!isOpen || !active) return null
  return (
    <ActivePrompt
      active={active}
      onBeforeInitialFocus={() => {
        if (!returnFocus.current?.isConnected) {
          const candidate = focusCandidate()
          if (candidate) returnFocus.current = candidate
        }
      }}
    />
  )
}

/** Keeps one SubDialog mounted across back-to-back queued prompts so focus never drops to document.body between items. */
function ActivePrompt({ active, onBeforeInitialFocus }: { readonly active: ActiveCostPrompt; readonly onBeforeInitialFocus: () => void }) {
  const { costPrompts, commands, dialogWindows } = useWorkbench()
  const [dontAskFor, setDontAskFor] = useState<{ readonly id: number; readonly checked: boolean }>({ id: active.id, checked: false })
  const dontAsk = dontAskFor.id === active.id && dontAskFor.checked
  const describedBy = useId()
  const bodyRef = useRef<HTMLDivElement>(null)

  // Move focus back to Cancel whenever a queued prompt advances to a new id.
  useEffect(() => {
    const form = bodyRef.current?.closest('form')
    const buttons = form ? [...form.querySelectorAll<HTMLButtonElement>('.dialog-footer button[type="button"]')] : []
    buttons.at(-1)?.focus()
  }, [active.id])

  const settings = () => {
    const doc = bodyRef.current?.ownerDocument ?? document
    flushSync(() => { costPrompts.answer(active.id, { run: false }) })
    const source = dialogWindows || doc.querySelector('[aria-modal="true"]') ? 'api' : 'toolbar'
    void commands.execute('preferences.options', { setting: 'queryExecution.bigQuery.costPrompt' }, source)
  }

  if (active.kind === 'single') {
    const text = costPromptText(active.request)
    return <SubDialog title={text.title} okLabel="Run" alert describedBy={describedBy} className="bigquery-cost-prompt"
      manageReturnFocus={false} onBeforeInitialFocus={onBeforeInitialFocus}
      onOk={() => costPrompts.answer(active.id, { run: true, dontAskAgain: dontAsk })} onCancel={() => costPrompts.answer(active.id, { run: false })}
      status={<button type="button" className="link-button" onClick={settings}>Cost settings…</button>}>
      <div id={describedBy} ref={bodyRef}>
        <p className="bigquery-cost-sentence">{text.sentence}</p>
        <p className="field-note">{text.note}</p>
      </div>
      <label className="checkbox-label"><input type="checkbox" checked={dontAsk} onChange={event => setDontAskFor({ id: active.id, checked: event.target.checked })} /> {text.optOut}</label>
    </SubDialog>
  }

  const text = multiCostPromptText(active.request)
  return <SubDialog title={text.title} okLabel="Run" alert describedBy={describedBy} className="bigquery-cost-prompt bigquery-cost-prompt-multi"
    manageReturnFocus={false} onBeforeInitialFocus={onBeforeInitialFocus}
    onOk={() => costPrompts.answer(active.id, { run: true, dontAskAgain: dontAsk })} onCancel={() => costPrompts.answer(active.id, { run: false })}
    status={<button type="button" className="link-button" onClick={settings}>Cost settings…</button>}>
    <div id={describedBy} ref={bodyRef}>
      <p className="bigquery-cost-sentence">{text.sentence}</p>
      <ul className="bigquery-cost-project-list" aria-label="BigQuery project cost breakdown">
        {text.rows.map(row => <li key={row.connectionId} className="bigquery-cost-project-row">
          <div className="bigquery-cost-project-head">
            <span className="bigquery-cost-project-name">
              <strong>{row.label}</strong>
              {row.dataset && <span className="bigquery-cost-project-dataset"> ({row.dataset})</span>}
              {row.environment && <EnvironmentTag environment={row.environment} place="list" about={row.label} />}
            </span>
            <span className="bigquery-cost-project-figure">{row.figure}</span>
          </div>
          <div className="bigquery-cost-project-detail field-note">{row.detail}</div>
          {row.capText && <div className={row.exceedsCap ? 'bigquery-cost-project-cap is-exceeded' : 'bigquery-cost-project-cap field-note'}>{row.capText}</div>}
        </li>)}
      </ul>
      <p className="bigquery-cost-total">{text.totalText}</p>
      <p className="field-note">{text.note}</p>
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={dontAsk} onChange={event => setDontAskFor({ id: active.id, checked: event.target.checked })} /> {text.optOut}</label>
  </SubDialog>
}

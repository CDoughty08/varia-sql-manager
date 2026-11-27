import { useId, useState } from 'react'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import SubDialog from './dialogs/SubDialog'
import EnvironmentTag from './EnvironmentTag'
import type { CostPromptRequest } from './services/bigquery-cost'
import { costPromptText, multiCostPromptText, type MultiProjectCostPromptRequest } from './services/bigquery-cost-prompt'

/**
 * Execute's cost prompt for a BigQuery query (docs/bigquery.md, Cost): above the threshold, or when the estimate may be
 * low. Supports both single-project prompts and aggregated multi-project Cross-Engine prompts so multiple projects never
 * stack N sequential modals. Opens with focus on Cancel and is announced as an alert dialog; Cost settings… opens Tools › Options there.
 */
export default function BigQueryCostPrompt() {
  const { costPrompts } = useWorkbench()
  const { pending, pendingMulti } = useServiceSnapshot(costPrompts)
  if (pending) return <Prompt key={pending.id} id={pending.id} request={pending.request} />
  if (pendingMulti) return <MultiPrompt key={pendingMulti.id} id={pendingMulti.id} request={pendingMulti.request} />
  return null
}

function Prompt({ id, request }: { id: number; request: CostPromptRequest }) {
  const { costPrompts, commands } = useWorkbench()
  const [dontAsk, setDontAsk] = useState(false)
  const describedBy = useId()
  const text = costPromptText(request)
  const settings = () => { costPrompts.answer(id, { run: false }); void commands.execute('preferences.options', { setting: 'queryExecution.bigQuery.costPrompt' }, 'toolbar') }
  return <SubDialog title={text.title} okLabel="Run" alert describedBy={describedBy} className="bigquery-cost-prompt"
    onOk={() => costPrompts.answer(id, { run: true, dontAskAgain: dontAsk })} onCancel={() => costPrompts.answer(id, { run: false })}
    status={<button type="button" className="link-button" onClick={settings}>Cost settings…</button>}>
    <div id={describedBy}>
      <p className="bigquery-cost-sentence">{text.sentence}</p>
      <p className="field-note">{text.note}</p>
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={dontAsk} onChange={event => setDontAsk(event.target.checked)} /> {text.optOut}</label>
  </SubDialog>
}

function MultiPrompt({ id, request }: { id: number; request: MultiProjectCostPromptRequest }) {
  const { costPrompts, commands } = useWorkbench()
  const [dontAsk, setDontAsk] = useState(false)
  const describedBy = useId()
  const text = multiCostPromptText(request)
  const settings = () => { costPrompts.answer(id, { run: false }); void commands.execute('preferences.options', { setting: 'queryExecution.bigQuery.costPrompt' }, 'toolbar') }
  return <SubDialog title={text.title} okLabel="Run" alert describedBy={describedBy} className="bigquery-cost-prompt bigquery-cost-prompt-multi"
    onOk={() => costPrompts.answer(id, { run: true, dontAskAgain: dontAsk })} onCancel={() => costPrompts.answer(id, { run: false })}
    status={<button type="button" className="link-button" onClick={settings}>Cost settings…</button>}>
    <div id={describedBy}>
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
    <label className="checkbox-label"><input type="checkbox" checked={dontAsk} onChange={event => setDontAsk(event.target.checked)} /> {text.optOut}</label>
  </SubDialog>
}

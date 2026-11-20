import { useId, useState } from 'react'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import SubDialog from './dialogs/SubDialog'
import type { CostPromptRequest } from './services/bigquery-cost'
import { costPromptText } from './services/bigquery-cost-prompt'

/**
 * Execute's cost prompt for a BigQuery query (docs/bigquery.md, Cost): above the threshold, or when the estimate may be
 * low. It opens with focus on Cancel and is announced as an alert dialog; Cost settings… opens Tools › Options there.
 */
export default function BigQueryCostPrompt() {
  const { costPrompts } = useWorkbench()
  const { pending } = useServiceSnapshot(costPrompts)
  return pending ? <Prompt key={JSON.stringify(pending.request)} request={pending.request} /> : null
}

function Prompt({ request }: { request: CostPromptRequest }) {
  const { costPrompts, commands } = useWorkbench()
  const [dontAsk, setDontAsk] = useState(false)
  const describedBy = useId()
  const text = costPromptText(request)
  const settings = () => { costPrompts.answer({ run: false }); void commands.execute('preferences.options', { setting: 'queryExecution.bigQuery.costPrompt' }, 'toolbar') }
  return <SubDialog title={text.title} okLabel="Run" alert describedBy={describedBy} className="bigquery-cost-prompt"
    onOk={() => costPrompts.answer({ run: true, dontAskAgain: dontAsk })} onCancel={() => costPrompts.answer({ run: false })}
    status={<button type="button" className="link-button" onClick={settings}>Cost settings…</button>}>
    <div id={describedBy}>
      <p className="bigquery-cost-sentence">{text.sentence}</p>
      <p className="field-note">{text.note}</p>
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={dontAsk} onChange={event => setDontAsk(event.target.checked)} /> {text.optOut}</label>
  </SubDialog>
}

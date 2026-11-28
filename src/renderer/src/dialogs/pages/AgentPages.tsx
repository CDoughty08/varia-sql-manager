import type { AgentServiceAction } from '../../../../shared/actions/catalog.ts'
import type { AgentJobFacts, AgentServiceFacts } from '../../../../shared/actions/schema.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import FactGrid from '../../kit/FactGrid'
import { agentDialogText, type StartJobDraft } from '../agent-dialogs'
import type { PageProps } from '../ObjectDialog'

/** Start Job at Step's General page (AG-2): the job's steps as SSMS lists them (Step and Name), the first chosen; OK starts there. */
export function StartJobPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as AgentJobFacts | undefined, draft = open.draft as StartJobDraft | undefined
  if (!model || !draft) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const disabled = !editable || !model.steps.length || model.running
  return <div className="agent-start-job">
    {!model.enabled && <ul className="object-dialog-warnings" aria-label="Warnings"><li><Icon name="info" /><span>{agentDialogText.disabled}</span></li></ul>}
    <section className="agent-props-section">
      <h3 className="agent-eyebrow" id="agent-start-step">{agentDialogText.startStep}</h3>
      <div className="agent-start-steps" role="radiogroup" aria-labelledby="agent-start-step">
        {model.steps.map(step => <label key={step.id} className="checkbox-label">
          <input type="radio" name="agent-start-step" value={step.id} checked={draft.step === step.id} disabled={disabled} onChange={() => dialogs.updateDraft({ step: step.id })} />
          {step.id}. {displayText(step.name)}</label>)}
      </div>
      {model.stepsTruncated && <p className="field-note">Only the first {model.steps.length.toLocaleString('en-US')} steps are listed.</p>}
    </section>
  </div>
}

/** The Agent node's Start, Stop and Restart confirmation (AG-2): SSMS's question naming the service and machine, the state the Service
 *  Control Manager reports, and what stopping it means. Its steps show in place once it runs. */
export function AgentServicePage({ open }: PageProps) {
  const model = open.model as AgentServiceFacts | undefined
  if (!model) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const action = open.dialog as AgentServiceAction
  return <div className="agent-service">
    <p>{agentDialogText.confirm(action, displayText(model.service), displayText(model.machine))}</p>
    <FactGrid className="agent-props-facts" facts={[{ id: 'state', label: 'Current state', value: agentDialogText.state(model.state), copyable: false }]} />
    {action !== 'startAgent' && <p className="field-note">{action === 'stopAgent' ? agentDialogText.stopNote : agentDialogText.restartNote}</p>}
  </div>
}

import { useMemo } from 'react'
import type { EstimatedPlanState } from '../services/queries'
import { useWorkbench } from '../core/WorkbenchContext'
import EmptyState from '../kit/EmptyState'
import PlanViewer from './PlanViewer'

export default function EstimatedPlans({ state, tabId, visible }: { state: EstimatedPlanState; tabId: string; visible: boolean }) {
  const { documents } = useWorkbench()
  const sources = useMemo(() => state.result?.plans.map((plan, index) => ({
    key: `${state.requestId}:${index}`, label: `Estimated plan ${index + 1} · Batch ${plan.batchNumber}, repetition ${plan.iteration}`,
    batchLabel: `Estimated · Batch ${plan.batchNumber}${plan.iteration > 1 ? `, repetition ${plan.iteration}` : ''}`,
    read: async () => plan.xml
  })) ?? [], [state.result, state.requestId])
  return <div className="estimated-plans" data-estimated-plan="">
    <div className="estimated-plan-context"><strong>Estimated</strong> · SQL was compiled without execution. Uses an isolated connection with the query database and Varia defaults;
      existing local temporary objects, prior session SET options and uncommitted changes are unavailable.</div>
    {state.loading ? <EmptyState icon="loading" detail="Compiling estimated execution plans…" />
      : state.error ? <div role="alert"><EmptyState icon="error" title="Estimated plan unavailable" detail={state.error} /></div>
      : !sources.length ? <EmptyState icon="execution-plan" detail="SQL Server returned no estimated plan for this selection. Some statements do not produce a plan; temporary objects created by the selection are not created during estimation." />
      : <PlanViewer key={state.requestId} sources={sources} identity={'estimated:' + state.requestId} scope={tabId} visible={visible} openDocument={key => {
        const index = sources.findIndex(source => source.key === key), plan = state.result?.plans[index]
        if (plan) { documents.openText({ name: `Estimated Plan ${index + 1}.sqlplan`, text: plan.xml, kind: 'sqlplan' }); documents.focusActive() }
      }} />}
  </div>
}

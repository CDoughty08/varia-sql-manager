import type { ActionStepStatus } from '../../../shared/actions/schema.ts'
import type { IconId } from '../../../shared/icons.ts'
import Icon from '../Icon'

/** A step's state: one the backend reported (`ActionStepStatus`), `running` while it runs, or `pending` before. */
export type StepState = 'pending' | 'running' | ActionStepStatus
/**
 * One step of a run. `meta` is the short text at the row's end ("Done · 0:31", "38 %"); `progress` (0-100) draws a bar
 * under a running step, an estimate the run reports (a restore's STATS), with `progressText` as its spoken value.
 */
export interface StepItem { readonly state: StepState; readonly text: string; readonly meta?: string; readonly progress?: number; readonly progressText?: string }

export const stepIcons: Readonly<Record<StepState, IconId>> = { pending: 'circle-outline', running: 'loading', done: 'check', failed: 'error', cancelled: 'debug-stop', skipped: 'circle-slash' }
/** What a screen reader hears before a step that has a state of its own; a pending step is read as its text alone. */
export const stepWords: Readonly<Record<StepState, string>> = { pending: '', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Stopped', skipped: 'Skipped' }
export const clampPercent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))

/**
 * The steps a run takes, in order, as a labelled list: an icon and the state in words, the step's text, its meta, and for
 * a step with `progress` a `progressbar` under it. Create Catalog's plan uses it, and so do the wave 5 runs (restore,
 * New Database, attach) in their run panels and dialogs.
 */
export default function StepList({ steps, labelledBy, className }: { readonly steps: readonly StepItem[]; readonly labelledBy: string; readonly className?: string }) {
  return <ol className={'step-list' + (className ? ' ' + className : '')} aria-labelledby={labelledBy}>
    {steps.map((step, index) => {
      const words = stepWords[step.state], percent = step.progress === undefined ? undefined : clampPercent(step.progress)
      return <li key={index} data-status={step.state}>
        <Icon name={stepIcons[step.state]} className={step.state === 'running' ? 'step-list-spinner' : undefined} />
        <span className="step-list-text">{words && <span className="visually-hidden">{words}: </span>}{step.text}</span>
        {step.meta && <span className="step-list-meta">{step.meta}</span>}
        {percent !== undefined && <div className="step-list-progress" role="progressbar" aria-label={step.text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
          aria-valuetext={step.progressText ?? `About ${Math.round(percent)} %`}><div className="step-list-fill" style={{ width: `${percent}%` }} /></div>}
      </li>
    })}
  </ol>
}

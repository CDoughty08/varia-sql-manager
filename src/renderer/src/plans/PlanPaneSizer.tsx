import { SplitSash } from '../kit/ResizableSplit'

/** Pointer capture follows the element into floating and popout documents. Save only a completed gesture. */
export function PlanPaneSizer({
  name, value, minimum, defaultWidth = value, reverse = false, resize, commit
}: {
  name: string
  value: number
  minimum: number
  defaultWidth?: number
  reverse?: boolean
  resize(value: number): void
  commit(value: number): void
}) {
  const bounds = { defaultWidth, minWidth: minimum, maxWidth: 600, minOtherWidth: 0 }
  return (
    <SplitSash
      className="plan-pane-sizer"
      side={reverse ? 'right' : 'left'}
      label={`Resize plan ${name}`}
      value={value}
      bounds={bounds}
      step={16}
      shiftStep={32}
      homeAction="min"
      endToMax
      revertOnCancel
      focusOnPointerDown
      onDragPreview={next => { if (next !== undefined) resize(next) }}
      onDragCancel={resize}
      onCommit={next => { resize(next); commit(next) }}
      onReset={() => { resize(defaultWidth); commit(defaultWidth) }}
    />
  )
}

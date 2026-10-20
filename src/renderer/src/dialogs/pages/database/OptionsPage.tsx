import { useState } from 'react'
import { databaseOptionDefs, optionDef, type DatabaseOptionDef } from '../../../../../shared/actions/database.ts'
import { useWorkbench } from '../../../core/WorkbenchContext'
import PropertyGrid, { controlId, type GridRow } from '../../../settings/PropertyGrid'
import { draftErrors, draftValue, modelValue, optionChoices, optionGroups, optionState, setOption } from '../../database-properties'
import type { PageProps } from '../../ObjectDialog'
import { databaseState, DescriptionPane, PageNote } from './shared'

const idPrefix = 'database-option-'
const header = databaseOptionDefs.filter(def => def.category === 'header')
/** The header's order on SSMS's page: Collation, Recovery model, Compatibility level, Containment type. */
const headerOrder = ['collation', 'recoveryModel', 'compatibilityLevel', 'containmentType']

/**
 * Database Properties' Options page: Collation, Recovery model, Compatibility level and Containment type, then "Other
 * options:" as SSMS's property grid by category, and the selected row's description. Changed values are bold; greyed
 * rows say why in the description.
 */
export default function OptionsPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const [focused, setFocused] = useState<string>()
  const { model, draft } = databaseState(open)
  if (!model || !draft) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const target = open.target
  const errors = draftErrors(model, draft, target)
  const change = (key: string, text: string) => dialogs.updateDraft(setOption(draft, key, text))
  const row = (def: DatabaseOptionDef): GridRow => {
    const state = optionState(def, model, draft, target), value = draftValue(draft, def) ?? ''
    const control = !def.settable || def.control === 'text' ? 'readonly' : def.control === 'integer' ? def.choices ? 'combo' : 'integer' : 'choice'
    return {
      key: def.key, label: def.label, description: def.description, control, value, choices: optionChoices(def, model), ...def.range ? { min: def.range.min, max: def.range.max } : {},
      changed: value !== (modelValue(model, def) ?? ''), disabled: !editable || state.disabled
    }
  }
  const focusedDef = focused ? optionDef(focused) : undefined
  const note = focusedDef ? optionState(focusedDef, model, draft, target).note : undefined
  return <div className="database-page database-options">
    {model.readOnlyReason && <PageNote>{model.readOnlyReason}</PageNote>}
    <div className="database-header" role="group" aria-label="Database options">
      {headerOrder.map(key => header.find(def => def.key === key)!).map(def => {
        const item = row(def), state = optionState(def, model, draft, target), id = controlId(def.key, idPrefix)
        return <div key={def.key} className="database-field" data-focused={focused === def.key || undefined} onPointerDown={() => setFocused(def.key)}>
          <label htmlFor={id}>{def.label}:</label>
          <select id={id} value={item.value} disabled={item.disabled} data-changed={item.changed || undefined} aria-description={state.note ?? def.description}
            onFocus={() => setFocused(def.key)} onChange={event => change(def.key, event.target.value)}>
            {item.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          {state.note && !model.readOnlyReason && <span className="field-note">{state.note}</span>}
        </div>
      })}
    </div>
    <div className="object-dialog-caption">Other options:</div>
    <div className="database-grid">
      <PropertyGrid label="Other options" idPrefix={idPrefix} groups={optionGroups(model).map(group => ({ label: group.category, rows: group.defs.map(row) }))}
        focused={focused} errors={errors} onFocusRow={setFocused} onChange={change} />
    </div>
    <DescriptionPane title={focusedDef?.label ?? 'Options'} text={focusedDef?.description ?? ''} notes={note ? [note] : []} />
  </div>
}

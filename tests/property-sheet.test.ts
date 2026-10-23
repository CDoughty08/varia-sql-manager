import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { databaseOptionDefs, optionDef, scopedConfigurationDefs } from '../src/shared/actions/database'
import { contrastPairs } from '../src/shared/theme/contrast-pairs'
import { densityUse } from '../src/shared/theme/metrics'
import { databaseChanged, initialDatabaseDraft, setOption } from '../src/renderer/src/dialogs/database-properties'
import PropertyField, { FactList, fieldAria } from '../src/renderer/src/kit/PropertyField'
import Segmented, { segmentedMaximum, segmentKey } from '../src/renderer/src/kit/Segmented'
import Switch from '../src/renderer/src/kit/Switch'
import { databaseStatusPill, fieldControl, problemSections, switchStates } from '../src/renderer/src/properties/fields'
import { databaseModel } from './fixtures/database-properties'
import { computed } from './fixtures/css-cascade'
import { stylesheetRules } from './fixtures/css-rules'

const html = (element: ReactElement) => renderToStaticMarkup(element)
const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) =>
  rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value
const forced = ['@media (forced-colors: active)']
const allDefs = [...databaseOptionDefs, ...scopedConfigurationDefs]

describe('property sheet controls', () => {
  it('shows booleans as switches, short enums as segments, long or server-supplied ones as lists, and what Varia does not change as text', () => {
    for (const def of allDefs) {
      const control = fieldControl(def)
      if (!def.settable || def.control === 'text') expect(control, def.key).toBe('fact')
      else if (def.control === 'bool') expect(control, def.key).toBe('switch')
      else if (control === 'segmented') expect(def.choices!.length, def.key).toBeLessThanOrEqual(segmentedMaximum)
    }
    expect(['recoveryModel', 'containmentType', 'restrictAccess', 'delayedDurability', 'pageVerify', 'legacyCardinalityEstimation'].map(key => fieldControl(optionDef(key)!))).toEqual(Array(6).fill('segmented'))
    // Eight compatibility levels and the server's collations keep a list.
    expect(['compatibilityLevel', 'collation'].map(key => fieldControl(optionDef(key)!))).toEqual(['select', 'select'])
    expect(fieldControl(optionDef('targetRecoveryTime')!)).toBe('integer')
    expect(fieldControl(optionDef('maxDopForSecondary')!)).toBe('combo')
    expect(fieldControl(optionDef('nestedTriggersEnabled')!)).toBe('fact')
    expect(switchStates(optionDef('autoClose')!)).toEqual({ on: 'True', off: 'False' })
  })
  it('moves through segments as radio buttons do: arrows wrap, Home and End jump, and a value no segment has starts at an end', () => {
    expect([segmentKey('ArrowRight', 3, 0), segmentKey('ArrowDown', 3, 2), segmentKey('ArrowLeft', 3, 0), segmentKey('ArrowUp', 3, 1)]).toEqual([1, 0, 2, 0])
    expect([segmentKey('Home', 3, 2), segmentKey('End', 3, 0), segmentKey('Enter', 3, 0), segmentKey('ArrowRight', 0, 0)]).toEqual([0, 2, undefined, undefined])
    expect([segmentKey('ArrowRight', 3, -1), segmentKey('ArrowLeft', 3, -1)]).toEqual([0, 2])
  })
  it('draws a switch as a checkbox with the switch role, and segments as one radio group with one tab stop', () => {
    const on = html(createElement(Switch, { id: 'p-autoClose', checked: true, onChange: () => {}, states: { on: 'True', off: 'False' }, changed: true, 'aria-describedby': 'p-autoClose-description' }))
    expect(on).toContain('type="checkbox"')
    expect(on).toContain('role="switch"')
    expect(on).toContain('checked=""')
    expect(on).toContain('data-changed="true"')
    expect(on).toContain('aria-describedby="p-autoClose-description"')
    expect(on).toContain('<span class="switch-state" aria-hidden="true">True</span>')
    const segments = html(createElement(Segmented, { id: 'p-recovery', labelledBy: 'p-recovery-label', segments: [{ value: 'FULL', label: 'Full' }, { value: 'BULK_LOGGED', label: 'Bulk-logged' }, { value: 'SIMPLE', label: 'Simple' }], value: 'SIMPLE', onChange: () => {} }))
    expect(segments).toContain('role="radiogroup" aria-labelledby="p-recovery-label"')
    expect(segments.match(/role="radio"/g)).toHaveLength(3)
    expect(segments.match(/tabindex="0"/g)).toHaveLength(1)
    expect(segments).toMatch(/aria-checked="true" tabindex="0"[^>]*>Simple</)
    // A value no segment has: none chosen, and the first segment is the tab stop.
    const unknown = html(createElement(Segmented, { id: 'x', labelledBy: 'x-label', segments: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }], value: 'C', onChange: () => {} }))
    expect(unknown).not.toContain('aria-checked="true"')
    expect(unknown).toMatch(/aria-checked="false" tabindex="0"[^>]*>A</)
  })
  it('labels a field, describes its control with its description and note, and points an error at its message', () => {
    expect(fieldAria('f', { description: 'd', note: 'n', error: 'e' })).toEqual({ 'aria-describedby': 'f-description f-note', 'aria-invalid': true, 'aria-errormessage': 'f-error' })
    expect(fieldAria('f', {})).toEqual({})
    const field = html(createElement(PropertyField, { id: 'f', label: 'Auto Close', description: 'Shuts down cleanly.', note: 'Not on master.', error: 'Bad.', changed: true, children: createElement('input', { id: 'f' }) }))
    expect(field).toContain('<div class="property-field-label"><label id="f-label" for="f" title="Shuts down cleanly.">Auto Close</label>')
    expect(field).toContain('<p class="property-field-description" id="f-description" title="Shuts down cleanly.">Shuts down cleanly.</p>')
    expect(field).toContain('id="f-note"')
    expect(field).toContain('id="f-error"')
    // The Changed mark sits beside the label, outside it, so it is never part of the control's name.
    expect(field).toContain('<span class="property-field-changed" aria-hidden="true">Changed</span>')
    const radios = html(createElement(PropertyField, { id: 'r', label: 'Recovery model', labelFor: false, children: createElement('div') }))
    expect(radios).not.toContain('for="r"')
    expect(html(createElement(FactList, { facts: [{ label: 'Size', value: '16.00 MB' }, { label: 'Owner', value: '' }] }))).toBe('<dl class="property-facts"><div class="property-fact"><dt>Size</dt><dd>16.00 MB</dd></div><div class="property-fact"><dt>Owner</dt><dd>—</dd></div></dl>')
  })
})

describe('Database Properties document rules', () => {
  it('is changed while the draft differs from what was read, and not once it is back', () => {
    const model = databaseModel(), draft = initialDatabaseDraft(model)
    expect(databaseChanged(model, draft)).toBe(false)
    expect(databaseChanged(model, setOption(draft, 'autoClose', 'true'))).toBe(true)
    expect(databaseChanged(model, setOption(setOption(draft, 'autoClose', 'true'), 'autoClose', 'false'))).toBe(false)
    expect(databaseChanged(model, setOption(draft, 'maxDop', '4'))).toBe(true)
    expect(databaseChanged(model, { ...draft, owner: 'AppUser' })).toBe(true)
  })
  it('marks Files for the owner and Options for every option', () => {
    expect([...problemSections(new Map([['owner', 'x'], ['autoClose', 'y'], ['maxDop', 'z']]))].sort()).toEqual(['files', 'options'])
    expect(problemSections(new Map()).size).toBe(0)
  })
  it('says the database\'s state in SMO\'s words, with a tone that only repeats them', () => {
    const pill = (general: Partial<ReturnType<typeof databaseModel>['general']>, options: Record<string, string> = {}) => databaseStatusPill(databaseModel({ general: { ...databaseModel().general, ...general } }, options))
    expect(pill({})).toEqual({ tone: 'success', label: 'Normal' })
    expect(pill({}, { readOnly: 'true' })).toEqual({ tone: 'warning', label: 'Normal, Read-Only' })
    expect(pill({}, { restrictAccess: 'SINGLE_USER' })).toEqual({ tone: 'warning', label: 'Normal, Single User' })
    expect(pill({ status: 'RESTORING', standby: true })).toEqual({ tone: 'running', label: 'Restoring, Standby' })
    expect(pill({ status: 'SUSPECT' })).toEqual({ tone: 'critical', label: 'Suspect' })
    expect(pill({ status: 'OFFLINE' })).toEqual({ tone: 'critical', label: 'Offline' })
  })
})

describe('property sheet styles', () => {
  it('shows a description only while its row is hovered or holds focus, without moving any row, and always shows notes and errors', () => {
    expect(valueOf('.property-field-description', 'visibility')).toBe('hidden')
    expect(valueOf('.property-field:hover .property-field-description, .property-field:focus-within .property-field-description', 'visibility')).toBe('visible')
    // Beside the control on one line, in space every row keeps: a click that moves focus away from a row whose description
    // collapsed would otherwise land on a row that had just moved up (a missed click in Database Properties).
    expect([valueOf('.property-field-description', 'grid-row'), valueOf('.property-field-description', 'white-space')]).toEqual(['1', 'nowrap'])
    expect(rules.filter(rule => !rule.at.length && /:(?:hover|focus-within)/.test(rule.selector) && rule.selector.includes('.property-field-description')).flatMap(rule => rule.declarations).map(declaration => declaration.property)).toEqual(['visibility'])
    expect(computed(['.property-field-note']).get('display')).toBe('flex')
    expect(computed(['.property-field-error']).get('color')).toBe('var(--varia-errorForeground)')
  })
  it('marks the chosen segment by fill, outline and weight, at once, hovered or not, and in the selection colors under forced colors', () => {
    const chosen = ['button', '.segmented-option', '[aria-checked="true"]']
    for (const state of [[], [':hover', ':not(:disabled)']]) {
      const style = computed([...chosen, ...state]), name = state.join('') || 'rest'
      expect([style.get('background-color'), style.get('color'), style.get('box-shadow'), style.get('font-weight'), style.get('transition')], name)
        .toEqual(['var(--varia-chip-activeBackground)', 'var(--varia-chip-activeForeground)', 'inset 0 0 0 1px var(--varia-chip-activeBorder)', '600', 'none'])
      const strong = computed([...chosen, ...state], true)
      expect([strong.get('forced-color-adjust'), strong.get('background-color'), strong.get('color')], name).toEqual(['none', 'Highlight', 'HighlightText'])
    }
  })
  it('moves the switch\'s thumb and fills its track when on, in the theme and under forced colors', () => {
    expect([valueOf('.switch::before', 'left'), valueOf('.switch:checked::before', 'left')]).toEqual(['2px', '14px'])
    expect([valueOf('.switch:checked', 'background'), valueOf('.switch:checked::before', 'background')]).toEqual(['var(--varia-button-background)', 'var(--varia-button-foreground)'])
    expect([valueOf('.switch:checked', 'background', forced), valueOf('.switch:checked::before', 'background', forced), valueOf('.switch', 'forced-color-adjust', forced)]).toEqual(['Highlight', 'HighlightText', 'none'])
    // State changes are instant, as selection is.
    expect(rules.filter(rule => /\.switch/.test(rule.selector)).flatMap(rule => rule.declarations).filter(declaration => declaration.property.startsWith('transition'))).toEqual([])
  })
  it('stacks each label over its control in a narrow document, and leaves the description to the tooltip where there is no room for it', () => {
    expect(valueOf('.property-field, .property-facts', 'grid-template-columns', ['@container (max-width: 640px)'])).toBe('minmax(0, 1fr)')
    expect(valueOf('.property-field-description', 'display', ['@container (max-width: 820px)'])).toBe('none')
  })
  it('sizes its fields from the control token and checks the controls\' contrast on the document', () => {
    expect(densityUse.control).toContain('.property-input')
    const on = (foreground: string, background: readonly string[]) => contrastPairs.some(pair => pair.foreground === foreground && pair.background.join() === background.join() && pair.minimum >= 3)
    expect(on('input.border', ['editor.background'])).toBe(true)
    expect(on('button.background', ['editor.background'])).toBe(true)
    expect(on('button.foreground', ['editor.background', 'button.background'])).toBe(true)
    expect(on('descriptionForeground', ['input.background'])).toBe(true)
  })
})

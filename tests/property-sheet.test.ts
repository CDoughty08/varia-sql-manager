import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { databaseOptionDefs, optionDef, scopedConfigurationDefs } from '../src/shared/actions/database'
import { contrastPairs } from '../src/shared/theme/contrast-pairs'
import { densityUse } from '../src/shared/theme/metrics'
import { databaseChanged, initialDatabaseDraft, setOption } from '../src/renderer/src/dialogs/database-properties'
import { initialFrameState } from '../src/renderer/src/kit/document-frame'
import PropertyField, { FactList, FieldHintStrip, fieldAria, nextHints, shownHint } from '../src/renderer/src/kit/PropertyField'
import { FilesSection, OptionField, type SectionProps } from '../src/renderer/src/properties/DatabaseProperties'
import type { DatabasePropertiesService, PropertiesState } from '../src/renderer/src/properties/DatabasePropertiesService'
import Segmented, { segmentedMaximum, segmentKey } from '../src/renderer/src/kit/Segmented'
import Switch from '../src/renderer/src/kit/Switch'
import { databaseStatusPill, fieldControl, problemSections, switchStates } from '../src/renderer/src/properties/fields'
import { databaseModel } from './fixtures/database-properties'
import { computed, selectorParts } from './fixtures/css-cascade'
import { stylesheetRules } from './fixtures/css-rules'

const html = (element: ReactElement) => renderToStaticMarkup(element)
const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) =>
  rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value
const forced = ['@media (forced-colors: active)']
const allDefs = [...databaseOptionDefs, ...scopedConfigurationDefs]
/** A declaration of a rule one of whose selectors is `selector`, in the at-rules `at`. */
const declared = (selector: string, property: string, at: readonly string[] = []) =>
  rules.filter(rule => selectorParts(rule.selector).includes(selector) && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).findLast(declaration => declaration.property === property)?.value
/** Database Properties' sections as a loaded document renders them, without the workbench. */
function sectionProps(): SectionProps {
  const model = databaseModel(), target = { kind: 'database', name: 'AppData' } as const
  const state: PropertiesState = { id: 'doc', target, label: 'AppData', server: 'srv', phase: 'ready', model, draft: initialDatabaseDraft(model), revision: 1, edits: 0, changed: false, stale: false, frame: initialFrameState([]), script: { state: 'idle', message: '' } }
  return { state, model, draft: state.draft!, editable: true, errors: new Map(), service: { updateDraft: () => {} } as unknown as DatabasePropertiesService }
}

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
  it('labels a field, describes its control with whether it changed, its description and note, and points an error at its message', () => {
    expect(fieldAria('f', { description: 'd', note: 'n', error: 'e' })).toEqual({ 'aria-describedby': 'f-description f-note', 'aria-invalid': true, 'aria-errormessage': 'f-error' })
    expect(fieldAria('f', { description: 'd', changed: true })).toEqual({ 'aria-describedby': 'f-changed f-description' })
    expect(fieldAria('f', {})).toEqual({})
    const field = html(createElement(PropertyField, { id: 'f', label: 'Auto Close', description: 'Shuts down cleanly.', note: 'Not on master.', error: 'Bad.', changed: true, children: createElement('input', { id: 'f' }) }))
    expect(field).toContain('<div class="property-field-label"><label id="f-label" for="f" title="Shuts down cleanly.">Auto Close</label>')
    // The description is the control's description, and shows whole in the hint strip rather than in the row.
    expect(field).toContain('<p class="property-field-description" id="f-description" hidden="">Shuts down cleanly.</p>')
    expect(field).toContain('id="f-note"')
    expect(field).toContain('id="f-error"')
    // The Changed mark sits beside the label, outside it, so it is never part of the control's name; it is part of its description.
    expect(field).toContain('<span class="property-field-changed" id="f-changed" aria-hidden="true">Changed</span>')
    const radios = html(createElement(PropertyField, { id: 'r', label: 'Recovery model', labelFor: false, children: createElement('div') }))
    expect(radios).not.toContain('for="r"')
    expect(html(createElement(FactList, { facts: [{ label: 'Size', value: '16.00 MB' }, { label: 'Owner', value: '' }] }))).toBe('<dl class="property-facts"><div class="property-fact"><dt>Size</dt><dd>16.00 MB</dd></div><div class="property-fact"><dt>Owner</dt><dd>—</dd></div></dl>')
  })
})

describe('property sheet hints and sections', () => {
  const autoClose = { id: 'a', label: 'Auto Close', description: 'Shuts down cleanly.' }, autoShrink = { id: 'b', label: 'Auto Shrink', description: 'Shrinks.' }
  const recovery = { id: 'c', label: 'Recovery model', description: 'Recovers.' }
  it('shows the description of the row the pointer entered or the control that took focus, whichever came last', () => {
    let hints = nextHints({}, 'focused', 'a', autoClose)
    expect(shownHint(hints)).toBe(autoClose)
    hints = nextHints(hints, 'hovered', 'b', autoShrink)
    expect(shownHint(hints)).toBe(autoShrink)
    // Tabbing on while the pointer rests on a row: the focused control's description shows, not the resting row's.
    hints = nextHints(hints, 'focused', 'c', recovery)
    expect(shownHint(hints)).toBe(recovery)
    // Leaving falls back to the other; entering the next row before leaving the last one, the late leave clears nothing.
    expect(shownHint(nextHints(hints, 'focused', 'c', undefined))).toBe(autoShrink)
    hints = nextHints(nextHints(hints, 'hovered', 'a', autoClose), 'hovered', 'b', undefined)
    expect(shownHint(hints)).toBe(autoClose)
    expect(shownHint(nextHints(nextHints(hints, 'hovered', 'a', undefined), 'focused', 'c', undefined))).toBeUndefined()
    expect(nextHints(hints, 'hovered', 'a', autoClose)).toBe(hints)
  })
  it('shows the whole description in the strip, hidden from screen readers, which have it as the control\'s description, and nothing without one', () => {
    expect(html(createElement(FieldHintStrip, { hint: autoClose }))).toBe('<div class="field-hint-dock" aria-hidden="true"><div class="field-hint" data-field="a"><span class="field-hint-label">Auto Close</span> Shuts down cleanly.</div></div>')
    // Empty, so :empty hides it: no blank well where no row has a description (General, Filegroups).
    expect(html(createElement(FieldHintStrip))).toBe('<div class="field-hint-dock" aria-hidden="true"><div class="field-hint"></div></div>')
  })
  it('shows what Varia does not change as read-only text that takes focus, named by its label and described, never as a live region', () => {
    const props = sectionProps()
    const facts = allDefs.filter(def => fieldControl(def) === 'fact' && props.model.options[def.key] !== undefined)
    expect(facts.length).toBeGreaterThan(3)
    expect(facts.some(def => def.description)).toBe(true)
    for (const def of facts) {
      const field = html(createElement(OptionField, { ...props, def })), id = `properties-doc-${def.key}`
      expect(field, def.key).not.toMatch(/<output|role="status"|aria-live/)
      // A stop of its own, as SSMS's read-only rows can be selected: focus fills the hint strip, and a screen reader hears
      // the label, the value and the description rather than run-on text.
      const described = def.description ? ` aria-describedby="${id}-description"` : ''
      expect(field, def.key).toContain(`<span id="${id}" class="property-value" role="textbox" aria-readonly="true" tabindex="0" aria-labelledby="${id}-label"${described}>`)
      expect(field, def.key).toContain(`<label id="${id}-label"`)
      if (def.description) expect(field, def.key).toContain(`id="${id}-description"`)
    }
  })
  it('puts Files\' facts and its Owner field in groups of their own', () => {
    const files = html(createElement(FilesSection, sectionProps()))
    expect([...files.matchAll(/<h3 class="properties-group-title"[^>]*>([^<]+)<\/h3>/g)].map(match => match[1])).toEqual(['Database', 'Ownership', 'Database files'])
    expect(files.indexOf('Ownership')).toBeLessThan(files.indexOf('for="properties-doc-owner"'))
    expect(files.indexOf('Use full-text indexing')).toBeLessThan(files.indexOf('Ownership'))
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
  it('shows a description whole in a strip laid over the rows, never cut in the row, and always shows notes and errors', () => {
    // The row has no description of its own to cut or to show: the strip under the sections shows it, wrapping.
    expect(rules.filter(rule => rule.selector.includes('.property-field-description'))).toEqual([])
    expect(valueOf('.property-field', 'grid-template-columns')).toBe('minmax(160px, 30%) minmax(0, 360px)')
    // The strip lies over the rows at the bottom of the column (sticky, its text out of the flow), so showing it moves no
    // row; the pointer passes through it; empty, it is not there at all, so no blank well shows where no row has a description.
    expect([valueOf('.field-hint-dock', 'position'), valueOf('.field-hint-dock', 'bottom'), valueOf('.field-hint-dock', 'pointer-events'), valueOf('.field-hint-dock', 'height')])
      .toEqual(['sticky', '0', 'none', 'calc(2 * var(--varia-line-xs) + 2 * var(--varia-space-1) + 1px)'])
    expect([valueOf('.field-hint', 'position'), valueOf('.field-hint', 'bottom'), valueOf('.field-hint', 'overflow-wrap'), valueOf('.field-hint:empty', 'display')]).toEqual(['absolute', '0', 'anywhere', 'none'])
    expect(valueOf('.field-hint', 'background')).toBe('var(--varia-editor-background)')
    expect(rules.filter(rule => rule.selector.startsWith('.field-hint')).flatMap(rule => rule.declarations).map(declaration => declaration.property)).not.toContain('white-space')
    // Focus scrolls a row above the strip rather than under it.
    expect(valueOf('.document-sections:has(> .field-hint-dock)', 'scroll-padding-bottom')).toBe(valueOf('.field-hint-dock', 'height'))
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
    // Its own colours keep the theme's focus ring, which can miss 3:1 on a forced-colors canvas: the ring takes the system's text colour.
    expect(declared('.switch:focus-visible', 'outline-color', forced)).toBe('CanvasText')
  })
  it('greys every disabled property control the same way, under forced colors in GrayText', () => {
    for (const selector of ['.property-input:disabled', '.property-browse:disabled', '.segmented-option:disabled', '.switch:disabled', '.switch:disabled + .switch-state']) expect(declared(selector, 'opacity'), selector).toBe('.5')
    const chosen = computed(['button', '.segmented-option', '[aria-checked="true"]', ':disabled'], true)
    expect([chosen.get('background-color'), chosen.get('color'), chosen.get('outline-color')]).toEqual(['Canvas', 'GrayText', '1px solid GrayText'])
    expect(computed(['.switch', ':disabled'], true).get('border-color')).toBe('GrayText')
  })
  it('stacks each label over its control when the sections column is narrow, measured on that column', () => {
    expect(valueOf('.document-sections', 'container')).toBe('document-sections / inline-size')
    expect(valueOf('.property-field, .property-facts', 'grid-template-columns', ['@container document-sections (max-width: 540px)'])).toBe('minmax(0, 1fr)')
    // No property rule follows the frame's width, which counts the section list too.
    expect(rules.filter(rule => rule.at.some(at => /^@container \(/.test(at)) && /\.propert/.test(rule.selector))).toEqual([])
  })
  it('sizes the files and filegroups grids to their text and wraps a long value rather than cutting it, keeping words whole that fit', () => {
    expect(declared('.properties-table > .object-dialog-grid', 'table-layout')).toBe('auto')
    // anywhere would let the auto layout size each column to one letter and split words that fit (Not Applicabl|e).
    for (const cell of ['.properties-table > .object-dialog-grid td', '.properties-table > .object-dialog-grid th']) {
      expect([declared(cell, 'white-space'), declared(cell, 'overflow-wrap'), declared(cell, 'text-overflow')], cell).toEqual(['normal', 'break-word', 'clip'])
    }
    expect(declared('.properties-table > .object-dialog-grid [data-wrap="never"]', 'white-space')).toBe('nowrap')
    // Only the path breaks anywhere: it takes the width the names and words leave.
    expect(declared('.properties-table > .object-dialog-grid [data-wrap="anywhere"]', 'overflow-wrap')).toBe('anywhere')
    const files = html(createElement(FilesSection, sectionProps()))
    expect([...files.matchAll(/<th scope="col" data-wrap="never">([^<]+)<\/th>/g)].map(match => match[1])).toEqual(['File Type', 'Size (MB)'])
    expect([...files.matchAll(/<td data-wrap="anywhere"><bdi>([^<]+)<\/bdi>/g)].map(match => match[1])).toEqual(['C:\\Data', 'C:\\Data'])
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

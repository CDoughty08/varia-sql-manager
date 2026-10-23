import { describe, expect, it } from 'vitest'
import { advancedCount, advancedSummary, colorName, customSummary, listStep } from '../src/renderer/src/connect-form'
import { connectionPresets } from '../src/shared/theme/connection-colors'
import { stylesheetRules } from './fixtures/css-rules'

const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) => rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value

describe('Connect dialog v2 form', () => {
  it('counts only the Advanced Properties a connection sets', () => {
    expect(advancedCount(undefined)).toBe(0)
    expect(advancedCount({})).toBe(0)
    // OK stores edited fields, so a value put back to its default (false) still counts, and an unset one does not.
    expect(advancedCount({ commandTimeout: 7, columnEncryption: false, packetSize: undefined })).toBe(2)
    expect(advancedSummary({})).toBe('')
    expect(advancedSummary({ connectTimeout: 20 })).toBe('1 property set')
    expect(advancedSummary({ connectTimeout: 20, applicationIntent: 'ReadOnly', multipleActiveResultSets: true })).toBe('3 properties set')
  })
  it('summarises the collapsed Custom Properties, so a production label stays in view', () => {
    expect(customSummary({})).toEqual({ name: undefined, color: undefined, environment: undefined, text: 'No name, color or environment' })
    const red = connectionPresets.find(preset => preset.name === 'red')!.stored
    expect(customSummary({ displayName: ' Development ', color: red, environment: 'Production' })).toEqual({ name: 'Development', color: 'Red', environment: 'Production', text: 'Name Development, Color Red, Environment Production' })
    // A Custom label still being typed ('' or blank) is not an environment yet; a custom colour reads as Custom.
    expect(customSummary({ environment: '  ', color: '#123456' })).toEqual({ name: undefined, color: 'Custom', environment: undefined, text: 'Color Custom' })
    expect(customSummary({ environment: 'UAT-EU' }).text).toBe('Environment UAT-EU')
    expect(colorName(red.toUpperCase())).toBe('Red')
    expect(colorName(undefined)).toBeUndefined()
  })
  it('moves through the server lists with the arrow keys, from the filter box and back to it', () => {
    // -1 is the filter box.
    expect(listStep(-1, 3, 'ArrowDown')).toBe(0)
    expect(listStep(0, 3, 'ArrowDown')).toBe(1)
    expect(listStep(2, 3, 'ArrowDown')).toBe(2)
    expect(listStep(1, 3, 'ArrowUp')).toBe(0)
    expect(listStep(0, 3, 'ArrowUp')).toBe(-1)
    expect(listStep(-1, 3, 'ArrowUp')).toBeUndefined()
    expect(listStep(1, 3, 'Home')).toBe(0)
    expect(listStep(0, 3, 'End')).toBe(2)
    // The filter box keeps Home and End for its text; an empty list and other keys are left alone.
    expect(listStep(-1, 3, 'Home')).toBeUndefined()
    expect(listStep(-1, 3, 'End')).toBeUndefined()
    expect(listStep(-1, 0, 'ArrowDown')).toBeUndefined()
    expect(listStep(1, 3, 'Enter')).toBeUndefined()
  })
  it('keeps one bounded two-pane size, stacking the panes in a narrow window', () => {
    expect(valueOf('.connection-modal.connect-dialog', 'width')).toBe('min(720px, calc(100vw - 40px))')
    expect(valueOf('.connection-modal.connect-dialog', 'height')).toBe('min(520px, calc(100vh - 40px))')
    expect(valueOf('.connect-panes', 'display')).toBe('flex')
    expect(valueOf('.connect-sources-pane', 'width')).toBe('272px')
    // Both panes scroll on their own, and what sits under Connect is bounded, so Connect stays in view.
    expect(valueOf('.connect-sources-pane .connection-sources', 'min-height')).toBe('0')
    // A long environment label shrinks in the list instead of pushing the name and itself out of the row.
    expect(valueOf('.connect-sources-pane .environment-tag[data-place="list"]', 'flex')).toBe('0 1 auto')
    expect(valueOf('.connect-form-scroll', 'overflow-y')).toBe('auto')
    expect(valueOf('.connect-outcome', 'max-height')).toBe('45%')
    expect(valueOf('.connect-outcome', 'overflow-y')).toBe('auto')
    expect(valueOf('.connect-panes', 'flex-direction', ['@media (max-width: 760px)'])).toBe('column')
  })
})

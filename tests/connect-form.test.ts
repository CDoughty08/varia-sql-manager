import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { advancedCount, advancedSummary, colorName, customSummary, listStep } from '../src/renderer/src/connect-form'
import EnvironmentTag from '../src/renderer/src/EnvironmentTag'
import { advancedDefaults, advancedToStore } from '../src/shared/connections'
import { connectionPresets } from '../src/shared/theme/connection-colors'
import { stylesheetRules } from './fixtures/css-rules'

const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) => rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value

describe('Connect dialog v2 form', () => {
  it('counts only the Advanced Properties a connection sets', () => {
    expect(advancedCount(undefined)).toBe(0)
    expect(advancedCount({})).toBe(0)
    // A stored command timeout always counts, since it overrides Tools › Options; an unset property does not.
    expect(advancedCount({ commandTimeout: 7, packetSize: undefined })).toBe(1)
    expect(advancedCount({ commandTimeout: 0 })).toBe(1)
    // OK stores a property edited back to its default, which sets nothing: it does not count.
    const edited = advancedToStore({ ...advancedDefaults, commandTimeout: '' }, new Set(['multipleActiveResultSets', 'columnEncryption']))
    expect(edited).toEqual({ multipleActiveResultSets: false, columnEncryption: false })
    expect(advancedSummary(edited)).toBe('')
    // An earlier version's OK stored every property: only its command timeout (which it keeps) is set.
    expect(advancedSummary({ ...advancedDefaults })).toBe('1 property set')
    const { commandTimeout: _, ...legacy } = advancedDefaults
    expect(advancedSummary(legacy)).toBe('')
    expect(advancedSummary({ ...advancedDefaults, packetSize: 8192, replication: true })).toBe('3 properties set')
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
    // A long custom label shrinks in the list instead of pushing the name and itself out of the row; a preset's word
    // (PROD, STAGING) keeps the base flex: none and stays whole, the name giving way to it.
    expect(valueOf('.connect-sources-pane .environment-tag[data-place="list"][data-custom]', 'flex')).toBe('0 1 auto')
    expect(valueOf('.environment-tag', 'flex')).toBe('none')
    expect(rules.filter(rule => rule.selector.includes('[data-place="list"]') && rule.declarations.some(declaration => declaration.property.startsWith('flex'))).map(rule => rule.selector)).toEqual(['.connect-sources-pane .environment-tag[data-place="list"][data-custom]'])
    expect(valueOf('.connect-form-scroll', 'overflow-y')).toBe('auto')
    // The outcome sits above the footer, so Connect and Stop never move; together they keep at most 55% of the pane.
    expect(valueOf('.connect-actions', 'max-height')).toBe('55%')
    expect(valueOf('.connect-outcome', 'min-height')).toBe('0')
    expect(valueOf('.connect-outcome', 'overflow-y')).toBe('auto')
    // Stacked (a narrow or zoomed window): one scroll, the list two rows tall, and Connect stuck to the bottom.
    const stacked = ['@media (max-width: 760px)']
    expect(valueOf('.connect-panes', 'flex-direction', stacked)).toBe('column')
    expect(valueOf('.connect-panes', 'overflow-y', stacked)).toBe('auto')
    expect(valueOf('.connect-sources-pane .connection-sources', 'height', stacked)).toBe('136px')
    expect(valueOf('.connect-form-scroll', 'overflow-y', stacked)).toBe('visible')
    expect(valueOf('.connect-actions', 'position', stacked)).toBe('sticky')
    expect(valueOf('.connect-actions', 'max-height', stacked)).toBe('40vh')
  })
  it('marks only a custom environment label as one that may give way', () => {
    const html = (environment: string) => renderToStaticMarkup(createElement(EnvironmentTag, { environment, place: 'list' }))
    for (const preset of ['Production', 'staging', 'Test', 'Development']) expect(html(preset), preset).not.toContain('data-custom')
    expect(html('UAT-EU')).toContain('<span class="environment-tag" data-place="list" data-tone="neutral" data-custom="">')
  })
})

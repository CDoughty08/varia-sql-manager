import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { advancedCount, advancedSummary, clampConnectRailWidth, colorName, connectRailLimits, customSummary, listStep, parseConnectionString, rowTitle } from '../src/renderer/src/connect-form'
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
    // A modifier or an IME composition leaves the key to the filter's text: Shift+Down selects, Ctrl+Down moves the caret.
    expect(listStep(-1, 3, 'ArrowDown', true)).toBeUndefined()
    expect(listStep(1, 3, 'ArrowUp', true)).toBeUndefined()
    expect(listStep(1, 3, 'Home', true)).toBeUndefined()
  })
  it('puts a saved row\'s name in its tooltip, since the narrow list cuts it short', () => {
    expect(rowTitle({ displayName: 'Production Finance Reporting Cluster Primary', server: 'prod-sql-01', database: 'FinanceDW' })).toBe('Production Finance Reporting Cluster Primary\nprod-sql-01 · FinanceDW')
    expect(rowTitle({ displayName: '', server: 'localhost', database: '' })).toBe('localhost')
  })
  it('keeps one bounded two-pane size, stacking the panes in a narrow window', () => {
    expect(valueOf('.connection-modal.connect-dialog', 'width')).toBe('min(900px, calc(100vw - 40px))')
    expect(valueOf('.connection-modal.connect-dialog', 'height')).toBe('min(730px, calc(100vh - 40px))')
    expect(valueOf('.connection-modal.connect-dialog', 'display')).toBe('grid')
    expect(valueOf('.connection-modal.connect-dialog', 'grid-template-columns')).toBe('var(--connect-rail-width, 320px) 5px minmax(0, 1fr)')
    // The panes are the grid's cells side by side with a 5px splitter; the actions are their sibling under the form.
    expect(valueOf('.connect-panes', 'display')).toBe('contents')
    expect(valueOf('.connect-sources-pane', 'grid-row')).toBe('2 / 4')
    expect(valueOf('.connect-splitter', 'grid-column')).toBe('2')
    expect(valueOf('.connect-splitter', 'grid-row')).toBe('2 / 4')
    expect(valueOf('.connect-actions', 'grid-column')).toBe('3')
    expect(valueOf('.connect-actions', 'position')).toBeUndefined()
    // Both panes scroll on their own, and what sits under Connect is bounded, so Connect stays in view.
    expect(valueOf('.connect-sources-pane .connection-sources', 'min-height')).toBe('0')
    // A long custom label shrinks in the list instead of pushing the name and itself out of the row; a preset's word
    // (PROD, STAGING) keeps the base flex: none and stays whole, the name giving way to it.
    expect(valueOf('.connect-sources-pane .environment-tag[data-place="list"][data-custom]', 'flex')).toBe('0 1 auto')
    expect(valueOf('.environment-tag', 'flex')).toBe('none')
    expect(rules.filter(rule => rule.selector.includes('[data-place="list"]') && rule.declarations.some(declaration => declaration.property.startsWith('flex'))).map(rule => rule.selector)).toEqual(['.connect-sources-pane .environment-tag[data-place="list"][data-custom]'])
    expect(valueOf('.connect-form-scroll', 'overflow-y')).toBe('auto')
    // The outcome sits above the footer, so Connect and Stop never move; together they keep at most 45% of the dialog.
    expect(valueOf('.connect-actions', 'max-height')).toBe('45%')
    expect(valueOf('.connect-outcome', 'min-height')).toBe('0')
    expect(valueOf('.connect-outcome', 'overflow-y')).toBe('auto')
    // Stacked (a narrow or zoomed window, via class or viewport media query): one scroll, splitter hidden, actions across.
    expect(valueOf('.connection-modal.connect-dialog.is-stacked', 'grid-template-columns')).toBe('minmax(0, 1fr)')
    expect(valueOf('.connection-modal.connect-dialog.is-stacked .connect-splitter', 'display')).toBe('none')
    expect(valueOf('.connection-modal.connect-dialog.is-stacked .connect-actions', 'grid-column')).toBe('1')
    const stacked = ['@media (max-width: 720px)']
    expect(valueOf('.connection-modal.connect-dialog', 'grid-template-columns', stacked)).toBe('minmax(0, 1fr)')
    expect(valueOf('.connect-panes', 'display', stacked)).toBe('flex')
    expect(valueOf('.connect-panes', 'flex-direction', stacked)).toBe('column')
    expect(valueOf('.connect-panes', 'overflow-y', stacked)).toBe('auto')
    expect(valueOf('.connect-splitter', 'display', stacked)).toBe('none')
    expect(valueOf('.connect-sources-pane .connection-sources', 'height', stacked)).toBe('156px')
    expect(valueOf('.connect-form-scroll', 'overflow-y', stacked)).toBe('visible')
    expect(valueOf('.connect-actions', 'position', stacked)).toBeUndefined()
    expect(valueOf('.connect-actions', 'grid-column', stacked)).toBe('1')
    // The rows draw their focus ring inside, which the scrolling list would clip, and Browse's Refresh stays beside the
    // source select rather than wrapping under it as a lone, borderless word.
    expect(valueOf('.connect-sources-pane .connection-choice:focus-visible, .connect-sources-pane .discovered-server:focus-visible', 'outline-offset')).toBe('-2px')
    expect(valueOf('.ui-field:focus-visible, .ui-button:focus-visible', 'outline-offset')).toBe('calc(-1 * var(--varia-space-0))')
    expect(valueOf('.connect-sources-pane .browse-toolbar', 'flex-wrap')).toBeUndefined()
    expect(valueOf('.connect-sources-pane .browse-toolbar select', 'min-width')).toBe('0')
  })
  it('clamps the resizable saved-connections rail safely against the form minimum width', () => {
    expect(connectRailLimits.defaultWidth).toBe(320)
    expect(clampConnectRailWidth(undefined, 900)).toBe(320)
    expect(clampConnectRailWidth(120, 900)).toBe(220)
    expect(clampConnectRailWidth(380, 900)).toBe(380)
    expect(clampConnectRailWidth(600, 900)).toBe(320)
    expect(clampConnectRailWidth(460, 740)).toBe(320)
  })
  it('parses ADO.NET / SqlClient connection strings without importing passwords', () => {
    const parsed = parseConnectionString('Server="tcp:sql.corp.local,1433";Initial Catalog=SalesLedger;User ID=reader;Password=super-secret;Encrypt=True;TrustServerCertificate=False;ApplicationIntent=ReadOnly;Connect Timeout=30;MultipleActiveResultSets=True;')
    expect(parsed.passwordOmitted).toBe(true)
    expect(parsed.patch).toEqual({ server: 'sql.corp.local,1433', database: 'SalesLedger', authentication: 'sql', username: 'reader', encrypt: 'mandatory', trustServerCertificate: false })
    expect(parsed.patch).not.toHaveProperty('password')
    expect(parsed.advancedPatch).toEqual({ applicationIntent: 'ReadOnly', connectTimeout: 30, multipleActiveResultSets: true })
    expect(parsed.matchedCount).toBe(8)
    expect(parseConnectionString('Data Source=localhost;Integrated Security=SSPI;Pwd=secret')).toEqual({
      patch: { server: 'localhost', authentication: 'windows' },
      advancedPatch: {},
      matchedCount: 2,
      passwordOmitted: true
    })
    expect(parseConnectionString('Server=az.database.windows.net;Authentication=Active Directory Interactive').patch).toEqual({
      server: 'az.database.windows.net',
      authentication: 'entraMfa'
    })
  })
  it('marks only a custom environment label as one that may give way', () => {
    const html = (environment: string) => renderToStaticMarkup(createElement(EnvironmentTag, { environment, place: 'list' }))
    for (const preset of ['Production', 'staging', 'Test', 'Development']) expect(html(preset), preset).not.toContain('data-custom')
    expect(html('UAT-EU')).toContain('<span class="environment-tag" data-place="list" data-tone="neutral" data-custom="">')
  })
})

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DocumentFrameView, DocumentHeader, FactLine, headerVerbs, type FrameSection, type HeaderVerb } from '../src/renderer/src/kit/DocumentFrame'
import { frameLimits, initialFrameState, resizeScript, revealBy, scriptLinesLabel, scriptPreview, scriptPreviewNote, scriptSizeKey, scrolledTo, sectionKey, sectionLabel, selectSection, setScriptOpen, spySection, toggleSection, verbTooltip, type FrameState } from '../src/renderer/src/kit/document-frame'
import ScriptDrawer, { scriptDrawerActions, type ScriptContent } from '../src/renderer/src/kit/ScriptDrawer'
import { scriptDestinations, scriptDestinationSpecs } from '../src/shared/scripting/catalog'
import { contrastPairs } from '../src/shared/theme/contrast-pairs'
import { densityUse } from '../src/shared/theme/metrics'
import { colorRegistry } from '../src/shared/theme/registry'
import { computed } from './fixtures/css-cascade'
import { stylesheetRules } from './fixtures/css-rules'

const html = (element: ReactElement) => renderToStaticMarkup(element)
const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) =>
  rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value
const forced = ['@media (forced-colors: active)']
const sections = [{ id: 'general', title: 'General' }, { id: 'files', title: 'Files' }, { id: 'options', title: 'Options' }]
const verb = (label: string, extra: Partial<HeaderVerb> = {}): HeaderVerb => ({ key: label, label, title: label, disabled: false, run: () => {}, ...extra })

describe('document frame state', () => {
  it('starts on the first section with the drawer closed, and keeps only known collapsed sections', () => {
    expect(initialFrameState(sections)).toEqual({ section: 'general', collapsed: [], scriptOpen: false, scriptSize: frameLimits.scriptDefault })
    expect(initialFrameState(sections, { collapsed: ['files', 'gone'], scriptOpen: true })).toEqual({ section: 'general', collapsed: ['files'], scriptOpen: true, scriptSize: frameLimits.scriptDefault })
    expect(initialFrameState([]).section).toBe('')
  })
  it('opens a collapsed section that is chosen, but not one that is only scrolled past', () => {
    const state: FrameState = { ...initialFrameState(sections), collapsed: ['options'] }
    expect(selectSection(state, sections, 'options')).toEqual({ ...state, section: 'options', collapsed: [] })
    expect(scrolledTo(state, 'options')).toEqual({ ...state, section: 'options' })
    // Nothing to change keeps the same object, so the document's service need not publish a snapshot.
    expect(selectSection(state, sections, 'general')).toBe(state)
    expect(selectSection(state, sections, 'nope')).toBe(state)
    expect(scrolledTo(state, 'general')).toBe(state)
    expect(scrolledTo(state, '')).toBe(state)
    expect(toggleSection(toggleSection(state, 'files'), 'files')).toEqual(state)
    expect(toggleSection(state, 'options').collapsed).toEqual([])
  })
  it('keeps the drawer within its bounds, by pointer and by key', () => {
    const state = initialFrameState(sections)
    expect(setScriptOpen(state, false)).toBe(state)
    expect(setScriptOpen(state, true).scriptOpen).toBe(true)
    expect([0, 0.123456, 0.9, Number.NaN, Number.POSITIVE_INFINITY].map(size => resizeScript(state, size).scriptSize)).toEqual([0.15, 0.15, 0.7, frameLimits.scriptDefault, frameLimits.scriptDefault])
    expect(resizeScript(state, 0.456).scriptSize).toBe(0.46)
    expect(resizeScript(state, frameLimits.scriptDefault)).toBe(state)
    // Up makes the drawer taller (its splitter moves up), Down shorter; Home and End go to the ends.
    expect(['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'Enter'].map(key => scriptSizeKey(0.35, key))).toEqual([0.4, 0.3, 0.15, 0.7, undefined, undefined])
    expect([scriptSizeKey(0.7, 'ArrowUp'), scriptSizeKey(0.15, 'ArrowDown')]).toEqual([0.7, 0.15])
  })
  it('moves through the section list as SSMS moves through its pages, without wrapping', () => {
    const ids = sections.map(section => section.id)
    expect(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'Enter'].map(key => sectionKey(key, ids, 'files'))).toEqual(['options', 'general', 'general', 'options', undefined, undefined])
    // Across the top of a narrow document the list is a row: Right and Left move as Down and Up do.
    expect(['ArrowRight', 'ArrowLeft'].map(key => sectionKey(key, ids, 'files'))).toEqual(['options', 'general'])
    // At either end the key stays where it is (it is still the list's key, so it does not scroll anything).
    expect([sectionKey('ArrowDown', ids, 'options'), sectionKey('ArrowRight', ids, 'options'), sectionKey('ArrowUp', ids, 'general'), sectionKey('Home', ids, 'general'), sectionKey('End', ids, 'options')]).toEqual(['options', 'options', 'general', 'general', 'options'])
    // An item the list no longer has moves from the first.
    expect(sectionKey('ArrowDown', ids, 'gone')).toBe('files')
    expect(sectionKey('ArrowDown', [], '')).toBeUndefined()
  })
  it('scrolls the list only as far as it takes to show the current section whole', () => {
    // Inside the view: nothing. Above or before it: back to its start. Below or after: to its end, or its start if it is longer than the view.
    expect([revealBy(10, 30, 0, 100), revealBy(-15, 5, 0, 100), revealBy(90, 112, 0, 100), revealBy(40, 180, 50, 100), revealBy(0, 100, 0, 100)]).toEqual([0, -15, 12, -10, 0])
  })
  it('marks the section whose heading reached the top, and the chosen one where the end of the scroll stops it', () => {
    const tops = [0, 400, 900, 1000]
    const view = (scrollTop: number) => ({ scrollTop, clientHeight: 300, scrollHeight: 1200 })
    expect(spySection([], view(0))).toBe(-1)
    expect([0, 399, 400 - frameLimits.spyOffset, 380, 850].map(top => spySection(tops, view(top)))).toEqual([0, 1, 1, 1, 1])
    // At the end (900 + 300 = 1200) the last section is current, unless the person chose one still in view.
    expect(spySection(tops, view(900))).toBe(3)
    expect(spySection(tops, view(900), 2)).toBe(2)
    expect(spySection([0, 400, 900, 1150], { scrollTop: 800, clientHeight: 300, scrollHeight: 1100 }, 2)).toBe(2)
    // A chosen section above the one the scroll reached, or one that is gone, does not hold.
    expect(spySection([0, 400, 900, 1000], { scrollTop: 900, clientHeight: 300, scrollHeight: 1200 }, 0)).toBe(3)
    expect(spySection(tops, view(900), 7)).toBe(3)
    // Away from the end, the scroll decides whatever was chosen.
    expect(spySection(tops, view(450), 3)).toBe(1)
  })
})

describe('script preview', () => {
  it('counts lines as an editor does', () => {
    expect(scriptPreview('')).toEqual({ text: '', lines: 0, shownLines: 0, truncated: false })
    expect(scriptPreview('SELECT 1').lines).toBe(1)
    expect(scriptPreview('SELECT 1\r\nGO\r\n')).toEqual({ text: 'SELECT 1\r\nGO\r\n', lines: 2, shownLines: 2, truncated: false })
    expect(scriptLinesLabel(scriptPreview('a'))).toBe('1 line')
    expect(scriptLinesLabel(scriptPreview('a\nb\n\n'))).toBe('3 lines')
  })
  it('cuts a long script at a line end and says how much shows', () => {
    const limits = { previewCharacters: 20, previewLines: 3 }
    expect(scriptPreview('a\nb\nc\n', limits)).toEqual({ text: 'a\nb\nc\n', lines: 3, shownLines: 3, truncated: false })
    expect(scriptPreview('a\r\nb\r\nc\r\nd', limits)).toEqual({ text: 'a\r\nb\r\nc', lines: 4, shownLines: 3, truncated: true })
    expect(scriptPreview('0123456789\n0123456789\n0123', limits)).toEqual({ text: '0123456789', lines: 3, shownLines: 1, truncated: true })
    // One line longer than the limit is cut inside it.
    expect(scriptPreview('x'.repeat(30), limits)).toEqual({ text: 'x'.repeat(20), lines: 1, shownLines: 1, truncated: true })
    const big = Array.from({ length: frameLimits.previewLines + 10 }, (_, index) => `PRINT ${index}`).join('\n')
    const preview = scriptPreview(big)
    expect([preview.lines, preview.shownLines, preview.truncated, preview.text.length <= frameLimits.previewCharacters]).toEqual([5010, 5000, true, true])
    expect(scriptPreviewNote(preview)).toBe('Showing the first 5,000 lines of 5,010. Open in Query Window, Save Script As… and Copy take the whole script.')
    expect(scriptPreviewNote(scriptPreview('SELECT 1'))).toBeUndefined()
    const wide = scriptPreview(('y'.repeat(99) + '\n').repeat(3000))
    expect([wide.truncated, wide.text.length <= frameLimits.previewCharacters, wide.text.endsWith('y')]).toEqual([true, true, true])
  })
  it('names sections that need attention in words, and verbs with their keys', () => {
    expect(sectionLabel({ id: 'files', title: 'Files', problem: true })).toBe('Files (needs attention)')
    expect(sectionLabel({ id: 'files', title: 'Files' })).toBe('Files')
    expect(verbTooltip('Save', { text: 'Ctrl+S' })).toBe('Save (Ctrl+S)')
    expect(verbTooltip('Stop Operation', undefined)).toBe('Stop Operation')
  })
})

describe('document frame markup', () => {
  it('draws one header row: where the object is, its name and state, then its controls and verbs', () => {
    const markup = html(createElement(DocumentHeader, {
      id: 'doc-1', title: 'AdventureWorks', crumbs: [{ label: 'localhost', title: 'localhost (SQL Server 17.0)' }, { label: 'Databases' }], subtitle: 'Database',
      state: createElement('span', { className: 'status-pill' }, 'Unsaved changes'), tools: createElement('button', { type: 'button' }, 'Every 2 s'),
      verbs: [verb('Stop', { emphasis: 'danger', icon: 'debug-stop' }), verb('Save', { emphasis: 'primary', title: 'Save (Ctrl+S)' }), verb('Apply', { emphasis: 'primary', disabled: true })]
    }))
    expect(markup).toBe('<header class="document-header"><div class="document-heading">'
      + '<nav class="document-crumbs" aria-label="Location"><ol>'
      + '<li title="localhost (SQL Server 17.0)"><span class="document-crumb">localhost</span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></li>'
      // A crumb is cut at 32 characters, so its tooltip is its label when the document gives no other.
      + '<li title="Databases"><span class="document-crumb">Databases</span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></li></ol></nav>'
      + '<h1 class="document-title" id="doc-1-title">AdventureWorks</h1><span class="document-subtitle">Database</span><span class="status-pill">Unsaved changes</span></div>'
      + '<div class="document-actions" role="group" aria-label="AdventureWorks actions"><button type="button">Every 2 s</button>'
      + '<button type="button" class="document-verb danger" title="Stop"><span class="codicon codicon-debug-stop" aria-hidden="true"></span>Stop</button>'
      // Only the first primary verb is filled.
      + '<button type="button" class="document-verb primary" title="Save (Ctrl+S)">Save</button>'
      + '<button type="button" class="document-verb" title="Apply" disabled="">Apply</button></div></header>')
    // No crumbs, no controls: the title alone.
    expect(html(createElement(DocumentHeader, { id: 'd', title: 'Activity Monitor' }))).toBe('<header class="document-header"><div class="document-heading"><h1 class="document-title" id="d-title">Activity Monitor</h1></div></header>')
  })
  it('makes verbs of catalogue commands, with the catalogue\'s words and icon unless the document names its own', () => {
    const ran: unknown[] = []
    const verbs = headerVerbs([{ command: 'file.save', emphasis: 'primary' }, { command: 'query.cancel', label: 'Stop', icon: 'debug-stop', emphasis: 'danger', args: { tabId: 't1' } }, { command: 'view.toggleResultsPane' }, { command: 'view.toggleResultsPane' }],
      [true, false, true, true], [true, true, true, false], id => id === 'file.save' ? { text: 'Ctrl+S' } : undefined, (id, args) => ran.push([id, args]))
    expect(verbs.map(({ run: _run, ...verb }) => verb)).toEqual([
      { key: 'file.save-0', label: 'Save', title: 'Save (Ctrl+S)', icon: 'save', emphasis: 'primary', disabled: false },
      { key: 'query.cancel-1', label: 'Stop', title: 'Stop', icon: 'debug-stop', emphasis: 'danger', disabled: true },
      // Only a command with a toggled condition is a toggle button, pressed or not.
      { key: 'view.toggleResultsPane-2', label: 'Toggle Results Pane', title: 'Toggle Results Pane', icon: 'output', emphasis: undefined, disabled: false, pressed: true },
      { key: 'view.toggleResultsPane-3', label: 'Toggle Results Pane', title: 'Toggle Results Pane', icon: 'output', emphasis: undefined, disabled: false, pressed: false }
    ])
    verbs[1].run()
    expect(ran).toEqual([['query.cancel', { tabId: 't1' }]])
    const markup = html(createElement(DocumentHeader, { id: 'd', title: 'Activity Monitor', verbs: verbs.slice(2) }))
    expect(markup).toContain('<button type="button" class="document-verb" title="Toggle Results Pane" aria-pressed="true">')
    expect(markup).toContain('<button type="button" class="document-verb" title="Toggle Results Pane" aria-pressed="false">')
    expect(html(createElement(DocumentHeader, { id: 'd', title: 'x', verbs: verbs.slice(0, 1) }))).not.toContain('aria-pressed')
  })
  it('lists facts as terms and values', () => {
    expect(html(createElement(FactLine, { facts: [{ label: 'Folder', value: 'Warehouse' }, { label: 'Started', value: '22:41:07 +01:00', title: '2026-10-22 22:41:07 +01:00' }] })))
      .toBe('<dl class="document-facts"><div><dt>Folder</dt><dd>Warehouse</dd></div><div title="2026-10-22 22:41:07 +01:00"><dt>Started</dt><dd>22:41:07 +01:00</dd></div></dl>')
  })
  it('draws sections in one column with their list, the current one marked and collapsed ones closed', () => {
    const frameSections: FrameSection[] = [
      { id: 'general', title: 'General', content: createElement('p', null, 'facts') },
      { id: 'files', title: 'Files', problem: true, content: createElement('p', null, 'files grid'), aside: createElement('span', { className: 'aside' }, '2 files') },
      { id: 'messages', title: 'Messages', collapsible: true, content: createElement('p', null, 'log') },
      { id: 'parameters', title: 'Parameters', collapsible: true, content: createElement('p', null, 'parameters') }
    ]
    const frame: FrameState = { ...initialFrameState(frameSections), section: 'files', collapsed: ['parameters'] }
    const markup = html(createElement(DocumentFrameView, { id: 'doc-2', title: 'AdventureWorks', sections: frameSections, frame, attributes: { 'data-designer': 'doc-2' } }))
    expect(markup.startsWith('<div class="document-frame" role="region" aria-labelledby="doc-2-title" data-document-frame="doc-2" data-designer="doc-2">')).toBe(true)
    expect(markup).toContain('<nav class="document-nav" aria-label="Sections">'
      + '<button type="button" class="document-nav-item" data-section="general" tabindex="-1" aria-controls="doc-2-section-general"><span class="document-nav-title">General</span></button>'
      + '<button type="button" class="document-nav-item" data-section="files" tabindex="0" aria-current="location" aria-label="Files (needs attention)" aria-controls="doc-2-section-files"><span class="document-nav-title">Files</span><span class="codicon codicon-error" aria-hidden="true"></span></button>'
      + '<button type="button" class="document-nav-item" data-section="messages" tabindex="-1" aria-controls="doc-2-section-messages">')
    // The list is one tab stop, on the current section, or the first when the current one is not in the list.
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1)
    const lost = html(createElement(DocumentFrameView, { id: 'doc-2', title: 'x', sections: frameSections, frame: { ...frame, section: 'gone' } }))
    expect(lost.match(/data-section="\w+" tabindex="0"/g)).toEqual(['data-section="general" tabindex="0"'])
    expect(markup).toContain('<div class="document-content document-sections">')
    expect(markup).toContain('<section class="document-section" id="doc-2-section-general" aria-labelledby="doc-2-section-general-heading" data-section="general"><div class="document-section-head">'
      + '<h2 class="document-section-title" id="doc-2-section-general-heading">General</h2></div><div class="document-section-body" id="doc-2-section-general-body"><p>facts</p></div></section>')
    expect(markup).toContain('<h2 class="document-section-title" id="doc-2-section-files-heading">Files</h2><span class="aside">2 files</span>')
    // A collapsible section's heading is a disclosure button; a collapsed one renders no body (a live one stops drawing).
    expect(markup).toContain('<h2 class="document-section-title" id="doc-2-section-messages-heading"><button type="button" aria-expanded="true" aria-controls="doc-2-section-messages-body">'
      + '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>Messages</button></h2></div><div class="document-section-body" id="doc-2-section-messages-body"><p>log</p></div>')
    expect(markup).toContain('<button type="button" aria-expanded="false" aria-controls="doc-2-section-parameters-body"><span class="codicon codicon-chevron-right" aria-hidden="true"></span>Parameters</button></h2></div></section>')
    expect(markup).not.toContain('<p>parameters</p>')
    expect(markup).not.toContain('document-script')
    // One section needs no list.
    expect(html(createElement(DocumentFrameView, { id: 'one', title: 'Folder', sections: frameSections.slice(0, 1), frame: initialFrameState(frameSections.slice(0, 1)) }))).not.toContain('document-nav')
    // Without sections the document draws its own body under the header (the Activity Monitor's tiles and grids).
    expect(html(createElement(DocumentFrameView, { id: 'am', title: 'Activity Monitor', facts: [{ label: 'Server', value: 'localhost' }], children: createElement('div', { className: 'tiles' }) })))
      .toBe('<div class="document-frame" role="region" aria-labelledby="am-title" data-document-frame="am"><header class="document-header"><div class="document-heading"><h1 class="document-title" id="am-title">Activity Monitor</h1></div></header>'
        + '<dl class="document-facts"><div><dt>Server</dt><dd>localhost</dd></div></dl><div class="document-content"><div class="tiles"></div></div></div>')
  })
  it('keeps the Script drawer\'s bar when it is closed, and shows each state of the script when it is open', () => {
    const drawer = (open: boolean, content: ScriptContent, notice?: string) => html(createElement(ScriptDrawer, { id: 'doc-3', open, size: 0.4, content, notice, onToggle: () => {}, onResize: () => {}, onDeliver: () => {} }))
    const closed = drawer(false, { state: 'ready', text: 'ALTER DATABASE [x] SET READ_ONLY\nGO\n' })
    expect(closed).toBe('<section class="document-script" aria-labelledby="doc-3-script-head"><div class="document-script-head">'
      + '<button type="button" id="doc-3-script-head" class="document-script-toggle" aria-expanded="false" aria-controls="doc-3-script"><span class="codicon codicon-chevron-right" aria-hidden="true"></span>Script</button>'
      + '<span class="document-script-lines">2 lines</span><span class="document-script-notice" role="status"></span><div class="document-script-actions" role="group" aria-label="Script">'
      // Script As's destinations, in its order and with its icons.
      + '<button type="button" class="icon-button" aria-label="Open in Query Window" title="Open in Query Window" data-destination="newQuery"><span class="codicon codicon-file-code" aria-hidden="true"></span></button>'
      + '<button type="button" class="icon-button" aria-label="Save Script As…" title="Save Script As…" data-destination="file"><span class="codicon codicon-save-as" aria-hidden="true"></span></button>'
      + '<button type="button" class="icon-button" aria-label="Copy" title="Copy" data-destination="clipboard"><span class="codicon codicon-clippy" aria-hidden="true"></span></button></div></div></section>')
    const open = drawer(true, { state: 'ready', text: 'ALTER DATABASE [x] SET READ_ONLY\nGO\n' }, 'Script copied to the clipboard.')
    expect(open).toContain('<section class="document-script" aria-labelledby="doc-3-script-head" data-open="" style="flex-basis:40%">'
      + '<div class="document-script-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize Script" tabindex="0" aria-valuenow="40" aria-valuemin="15" aria-valuemax="70"></div>')
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('<span class="document-script-notice" role="status">Script copied to the clipboard.</span>')
    expect(open).toContain('<div class="document-script-body" id="doc-3-script"><textarea class="document-script-text" readOnly="" aria-label="Script text" spellCheck="false" wrap="off">ALTER DATABASE [x] SET READ_ONLY\nGO\n</textarea></div>')
    // Nothing to deliver yet: the actions wait for a script.
    for (const content of [{ state: 'idle', message: 'No changes to script.' }, { state: 'loading' }, { state: 'ready', text: '' }, { state: 'failed', error: { message: 'Could not script.', code: 'SCRIPT_FAILED' } }] as ScriptContent[]) {
      const markup = drawer(true, content)
      expect(markup.match(/class="icon-button"[^>]*disabled=""/g)?.length, content.state).toBe(3)
      expect(markup, content.state).not.toContain('document-script-lines')
    }
    expect(drawer(true, { state: 'idle', message: 'No changes to script.' })).toContain('<p class="document-script-empty">No changes to script.</p>')
    expect(drawer(true, { state: 'loading' })).toContain('<div class="skeleton" role="status"><span class="visually-hidden">Scripting…</span>')
    expect(drawer(true, { state: 'ready', text: '' })).toContain('<p class="document-script-empty">The script is empty.</p>')
    // A failed preview is a status, not an alert: it must not interrupt someone typing.
    expect(drawer(true, { state: 'failed', error: { message: 'Could not script.', code: 'SCRIPT_FAILED' } })).toContain('<p class="inline-error-message" role="status">Could not script.</p>')
    const long = drawer(true, { state: 'ready', text: 'PRINT 1\n'.repeat(frameLimits.previewLines + 1) })
    expect(long).toContain('<p class="document-script-note">Showing the first 5,000 lines of 5,001. Open in Query Window, Save Script As… and Copy take the whole script.</p>')
    // The drawer's words and icons are the scripting catalogue's.
    expect(scriptDrawerActions).toEqual(scriptDestinations.map(destination => ({ destination, label: scriptDestinationSpecs[destination].drawerTitle, icon: scriptDestinationSpecs[destination].icon })))
  })
  it('adds the drawer under the content when the document has a script, from the frame state', () => {
    const frame = { ...initialFrameState(sections), scriptOpen: true, scriptSize: 0.25 }
    const markup = html(createElement(DocumentFrameView, { id: 'doc-4', title: 'AdventureWorks', sections: sections.map(section => ({ ...section, content: section.title })), frame,
      script: { content: { state: 'ready', text: 'SELECT 1' }, onDeliver: () => {} } }))
    expect(markup).toMatch(/<\/div><\/div><section class="document-script" aria-labelledby="doc-4-script-head" data-open="" style="flex-basis:25%">/)
    // Without a frame state there is nowhere to keep the drawer's height, so there is no drawer.
    expect(html(createElement(DocumentFrameView, { id: 'doc-5', title: 'x', script: { content: { state: 'loading' }, onDeliver: () => {} } }))).not.toContain('document-script')
  })
})

describe('document frame styles and colors', () => {
  it('marks the current section by more than its fill, at once, hovered or not, and in the selection colors under forced colors', () => {
    const current = ['button', '.document-nav-item', '[aria-current="location"]', ':not(:disabled)']
    for (const state of [[], [':hover']]) {
      const style = computed([...current, ...state]), name = state.join('') || 'rest'
      // button:hover:not(:disabled) outranks a lone state rule; the current section must keep its fill and edge under the pointer.
      expect(style.get('background-color'), name).toBe('var(--varia-list-inactiveSelectionBackground)')
      expect(style.get('color'), name).toBe('var(--varia-list-inactiveSelectionForeground)')
      expect(style.get('box-shadow'), name).toBe('inset 2px 0 0 var(--varia-panelTitle-activeBorder)')
      expect(style.get('transition'), name).toBe('none')
      // Out of forcing, it sets every colour itself, so no theme colour reaches it.
      const strong = computed([...current, ...state], true)
      expect([strong.get('forced-color-adjust'), strong.get('background-color'), strong.get('color')], name).toEqual(['none', 'Highlight', 'HighlightText'])
    }
    expect(computed([...current, ':focus-visible'], true).get('outline-color')).toBe('2px solid HighlightText')
    expect(valueOf('.document-nav-item[aria-current="location"] > .codicon', 'color', forced)).toBe('HighlightText')
    // Forced colors would draw the transparent button border round every item.
    expect(computed(['button', '.document-nav-item'], true).get('border-style')).toBe('none')
    expect(valueOf('.document-script-splitter', 'background', forced)).toBe('CanvasText')
    expect(valueOf('.document-script-splitter:hover, .document-script-splitter:focus-visible', 'outline', forced)).toBe('2px solid Highlight')
    // The read-only script box and the splitter show keyboard focus.
    expect(valueOf('.document-script-text:focus-visible', 'outline')).toBe('1px solid var(--varia-focusBorder)')
    expect(valueOf('.document-script-splitter:hover, .document-script-splitter:focus-visible', 'background')).toBe('var(--varia-sash-hoverBorder)')
  })
  it('keeps a danger verb in the error colour when hovered, and a pressed verb in the selection colours', () => {
    const danger = ['button', '.document-verb', '.danger', ':not(.primary)', ':not(:disabled)']
    for (const state of [[], [':hover']]) {
      const style = computed([...danger, ...state]), name = state.join('') || 'rest'
      // button:hover:not(:disabled) outranks a lone .danger rule: the words would turn neutral just as the pointer reaches Stop.
      expect([style.get('color'), style.get('border-color')], name).toEqual(['var(--varia-errorForeground)', 'var(--varia-errorForeground)'])
    }
    expect(computed([...danger, ':hover']).get('background-color')).toBe('var(--varia-button-secondaryHoverBackground)')
    const pressed = ['button', '.document-verb', '[aria-pressed="true"]', ':not(.primary)', ':not(:disabled)']
    for (const state of [[], [':hover']]) {
      const style = computed([...pressed, ...state]), name = state.join('') || 'rest'
      expect([style.get('background-color'), style.get('color'), style.get('border-color'), style.get('transition')], name)
        .toEqual(['var(--varia-list-inactiveSelectionBackground)', 'var(--varia-list-inactiveSelectionForeground)', 'var(--varia-panelTitle-activeBorder)', 'none'])
      const strong = computed([...pressed, ...state], true)
      expect([strong.get('forced-color-adjust'), strong.get('background-color'), strong.get('color'), strong.get('border-color')], name).toEqual(['none', 'Highlight', 'HighlightText', 'Highlight'])
    }
    // Off, a toggle verb is an ordinary one.
    expect(computed(['button', '.document-verb', '[aria-pressed="false"]', ':not(.primary)', ':not(:disabled)']).get('border-color')).toBe('var(--varia-button-border)')
  })
  it('sizes its bars, buttons and rows from the density tokens', () => {
    expect(densityUse.bar).toContain('.document-script-head')
    expect(densityUse.control).toContain('.document-verb')
    expect(densityUse.row).toContain('.document-nav-item')
  })
  it('reuses existing keys, with pairs for every surface it draws on', () => {
    for (const key of ['breadcrumb.foreground', 'breadcrumb.separatorForeground'] as const) expect(colorRegistry[key].consumers, key).toContain('css')
    const has = (foreground: string, background: readonly string[], minimum: number) => contrastPairs.some(pair => pair.foreground === foreground && pair.minimum === minimum && pair.background.join() === background.join())
    expect(has('list.inactiveSelectionForeground', ['editor.background', 'list.inactiveSelectionBackground'], 4.5)).toBe(true)
    expect(has('panelTitle.activeBorder', ['editor.background', 'list.inactiveSelectionBackground'], 3)).toBe(true)
    expect(has('errorForeground', ['editor.background', 'list.inactiveSelectionBackground'], 3)).toBe(true)
    expect(has('errorForeground', ['editor.background', 'button.secondaryHoverBackground'], 4.5)).toBe(true)
    expect(has('focusBorder', ['editor.background', 'list.inactiveSelectionBackground'], 3)).toBe(true)
    expect(has('sash.hoverBorder', ['panel.background'], 3)).toBe(true)
    expect(has('breadcrumb.separatorForeground', ['editor.background'], 4.5)).toBe(true)
  })
})

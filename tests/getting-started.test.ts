import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { commandIds } from '../src/shared/commands/catalog'
import { defaultRules, resolveKeybinding, type Platform } from '../src/shared/commands/keybindings'
import { gestureIds } from '../src/shared/commands/gestures'
import { guideIds, guideMetadata, isGuideId, matchingGuides } from '../src/shared/help/catalog'
import { lessonCommand, lessonShortcut, settingValueLabel } from '../src/shared/help/references'
import { defaultSettings, settingKeys } from '../src/shared/settings/catalog'
import { HelpService } from '../src/renderer/src/help/HelpService'
import HelpDocument, { guideLoaders } from '../src/renderer/src/help/HelpDocument'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { documentFixture } from './fixtures/documents'
import { workbenchFixture } from './fixtures/workbench'

describe('Getting Started registration and dependencies', () => {
  it('loads exactly one page per registry entry and validates real dependencies and section content', async () => {
    expect(Object.keys(guideLoaders).sort()).toEqual(guideIds.map(id => `./guides/${id}.tsx`).sort())
    const fixture = workbenchFixture()
    try {
      for (const id of guideIds) {
        const guide = guideMetadata(id)
        expect(new Set(guide.sections.map(section => section.id)).size).toBe(guide.sections.length)
        expect(guide.sections.some(section => section.id === 'related')).toBe(false)
        expect(guide.related.every(related => isGuideId(related) && related !== id)).toBe(true)
        expect(guide.commands.every(ref => commandIds.includes(ref.id))).toBe(true)
        expect(guide.settings.every(key => settingKeys.includes(key))).toBe(true)
        expect(guide.gestures.every(key => gestureIds.includes(key))).toBe(true)
        expect(guide.sourceAreas.every(path => existsSync(path))).toBe(true)
        fixture.help.open(id)
        const Page = (await guideLoaders[`./guides/${id}.tsx`]()).default
        const html = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(Page, { documentId: fixture.help.getSnapshot().documentId! }) }))
        for (const section of guide.sections) expect(html).toContain(section.title)
        expect(new Set([...html.matchAll(/data-help-command="([^"]+)" data-help-context="([^"]+)"/g)].map(match => `${match[1]}:${match[2]}`))).toEqual(new Set(guide.commands.map(ref => `${ref.id}:${ref.context}`)))
        for (const [, command] of html.matchAll(/data-help-action="([^"]+)"/g)) expect(guide.commands.some(ref => ref.id === command)).toBe(true)
        expect(new Set([...html.matchAll(/data-help-setting="([^"]+)"/g)].map(match => match[1]))).toEqual(new Set(guide.settings))
        expect(new Set([...html.matchAll(/data-help-gesture="([^"]+)"/g)].map(match => match[1]))).toEqual(new Set(guide.gestures))
        expect(html).not.toMatch(/<iframe|<script|contenteditable|type="password"/)
      }
      expect(fixture.api.execute).not.toHaveBeenCalled()
    } finally { fixture.dispose() }
  })
  it('searches all words across guide metadata and refuses inherited/unknown route names', () => {
    expect(matchingGuides('copy headers')).toEqual(['results'])
    expect(matchingGuides('  ENTRA ')).toEqual(['connect'])
    expect(matchingGuides('not-a-feature')).toEqual([])
    expect(matchingGuides('')).toEqual(guideIds)
    for (const value of ['constructor', '__proto__', '../connect', 'connect'.repeat(1000), null]) expect(isGuideId(value)).toBe(false)
  })
})

describe('contextual references', () => {
  it.each<Platform>(['win32', 'linux', 'darwin'])('uses effective rules in lesson focus on %s', platform => {
    const rules = defaultRules(platform)
    expect(lessonShortcut('query.execute', 'queryEditor', platform, rules)).toBe('F5')
    expect(lessonShortcut('query.execute', 'resultsGrid', platform, rules)).toBeUndefined()
    expect(lessonShortcut('output.copy', 'resultsGrid', platform, rules)).toBe(platform === 'darwin' ? '⌘C' : 'Ctrl+C')
    expect(lessonShortcut('query.execute', 'queryEditor', platform, rules.filter(rule => rule.command !== 'query.execute'))).toBeUndefined()
    const remapped = [...rules.filter(rule => rule.command !== 'query.execute'), resolveKeybinding('query.execute', { key: 'mod+shift+enter', when: 'editorFocus || queryBarFocus' }, platform)!]
    expect(lessonShortcut('query.execute', 'queryEditor', platform, remapped)).toBe(platform === 'darwin' ? '⇧⌘↩' : 'Ctrl+Shift+Enter')
  })
  it('suppresses global shortcuts shadowed by a narrower scope and respects native editor prefixes', () => {
    const queryRule = resolveKeybinding('query.execute', { key: 'f9', when: 'hasActiveDocument && activeDocumentIsText && activeDocumentIsQuery && hasConnection && backendReady' }, 'win32')!
    expect(lessonShortcut('query.execute', 'queryEditor', 'win32', [queryRule])).toBe('F9')
    expect(lessonShortcut('query.execute', 'resultsGrid', 'win32', [queryRule])).toBe('F9')
    expect(lessonShortcut('view.zoomIn', 'workbench', 'win32', defaultRules('win32'))).toBe('Ctrl+=')
    expect(lessonShortcut('edit.copy', 'resultsGrid', 'win32', defaultRules('win32'))).toBeUndefined()
    const global = resolveKeybinding('file.new', { key: 'f5' }, 'win32')!
    const scoped = resolveKeybinding('query.execute', { key: 'f5', when: 'editorFocus || queryBarFocus' }, 'win32')!
    expect(lessonShortcut('file.new', 'workbench', 'win32', [global, scoped])).toBe('F5')
    expect(lessonShortcut('file.new', 'queryEditor', 'win32', [global, scoped])).toBeUndefined()
    const chord = resolveKeybinding('query.execute', { key: 'mod+k mod+e', native: true, bridge: true }, 'win32')!
    const prefix = resolveKeybinding('file.new', { key: 'mod+k' }, 'win32')!
    expect(lessonShortcut('query.execute', 'queryEditor', 'win32', [prefix, chord])).toBe('Ctrl+K Ctrl+E')
    expect(lessonShortcut('file.new', 'queryEditor', 'win32', [prefix, chord])).toBeUndefined()
    expect(lessonShortcut('query.execute', 'workbench', 'win32', [chord])).toBeUndefined()
  })
  it('derives command paths, dynamic titles and setting values from the real catalogs', () => {
    expect(lessonCommand('query.execute', 'win32', defaultSettings)).toEqual({ title: 'Execute', path: 'Query › Execute' })
    expect(lessonCommand('output.copy', 'win32', defaultSettings).path).toBe('Results context menu › Copy')
    expect(settingValueLabel('queryResults.grid.includeColumnHeaders', { ...defaultSettings, 'queryResults.grid.includeColumnHeaders': true })).toBe('On')
  })
})

describe('read-only guide document', () => {
  it('reuses a tab, preserves same-route position, bounds search and clears on close without saving or SQL', async () => {
    const fixture = documentFixture(), focus = vi.fn(), help = new HelpService(fixture.documents, focus)
    try {
      help.open()
      const id = help.getSnapshot().documentId!
      help.search('x'.repeat(1000))
      expect(help.getSnapshot().search).toHaveLength(200)
      help.open()
      expect(help.getSnapshot().search).toHaveLength(200)
      help.open('results')
      expect(help.getSnapshot().search).toBe('')
      const route = help.getSnapshot().route, frame = { ...help.getSnapshot().frame, section: 'limits' }
      help.setFrame(route, frame)
      help.open('results')
      expect(help.getSnapshot().frame).toBe(frame)
      help.open('connect')
      help.setFrame(route, frame)
      expect(help.getSnapshot().frame.section).toBe('prepare')
      help.open('constructor')
      expect(help.getSnapshot().route).toEqual({ kind: 'missing' })
      expect(fixture.documents.getSnapshot().documents).toHaveLength(1)
      expect(fixture.models.size).toBe(0)
      expect(fixture.documents.get(id)).toMatchObject({ kind: 'help', dirty: false, connectionId: undefined })
      expect(fixture.documents.savable(id)).toBe(false)
      expect(fixture.documents.inSaveAll(id)).toBe(false)
      expect(fixture.documents.follows(id, 'server')).toBe(false)
      await fixture.documents.close(id)
      expect(help.getSnapshot().documentId).toBeUndefined()
      expect(fixture.api.closeQuerySession).not.toHaveBeenCalled()
    } finally { help.dispose(); fixture.documents.dispose() }
  })
  it('routes menu/palette entry points and opens the actual setting page through Options', async () => {
    const fixture = workbenchFixture()
    try {
      await fixture.commands.execute('help.gettingStarted', undefined, 'palette')
      expect(fixture.help.getSnapshot().route).toEqual({ kind: 'home' })
      await fixture.commands.execute('help.openGuide', { guideId: 'results' }, 'toolbar')
      expect(fixture.help.getSnapshot().route).toEqual({ kind: 'guide', id: 'results' })
      await fixture.commands.execute('preferences.options', { settingsPage: 'queryResults.sqlServer.grid' }, 'toolbar')
      expect(fixture.settings.dialog.getSnapshot()).toMatchObject({ open: true, page: 'queryResults.sqlServer.grid' })
      fixture.help.open('../private-server')
      const html = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(HelpDocument, { documentId: fixture.help.getSnapshot().documentId! }) }))
      expect(html).toContain('This guide is not available')
      expect(html).not.toContain('private-server')
    } finally { fixture.dispose() }
  })
})

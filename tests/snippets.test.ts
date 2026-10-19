import { describe, expect, it } from 'vitest'
import { SnippetParser, Placeholder, Variable } from 'monaco-editor/editor/contrib/snippet/browser/snippetParser.js'
import { snippetCategories, snippetLimits, snippets } from '../src/renderer/src/editor/snippets'

describe('code snippets', () => {
  it("cover SSMS's Code Snippets Manager categories, in its order, each with a snippet", () => {
    expect(snippetCategories).toEqual(['Function', 'Index', 'Login', 'Role', 'Schema', 'Stored Procedure', 'Synonym', 'Table', 'Trigger', 'User', 'User Defined Data Type',
      'User Defined Table Type', 'User Defined Type', 'View'])
    const expansions = snippets.filter(snippet => snippet.kind === 'expansion')
    // Listed category by category, in that order, so the picker's groups follow SSMS.
    expect([...new Set(expansions.map(snippet => snippet.category))]).toEqual([...snippetCategories])
    expect(snippets.filter(snippet => snippet.kind === 'surround').map(snippet => snippet.title)).toEqual(['Begin', 'If', 'While'])
  })
  it('parse as Monaco snippets with tab stops and an end', () => {
    const parser = new SnippetParser()
    for (const snippet of snippets) {
      const parsed = parser.parse(snippet.body, true, true)
      expect(parsed.toString().length, snippet.id).toBeGreaterThan(0)
      // Every placeholder Monaco reads is one the body names: no stray `$` was taken for syntax.
      const stops = parsed.placeholders.filter(placeholder => !placeholder.isFinalTabstop).map(placeholder => placeholder.index)
      expect(stops.length > 0 || snippet.kind === 'surround', snippet.id).toBe(true)
      expect(parsed.placeholders.some(placeholder => placeholder.isFinalTabstop), snippet.id).toBe(true)
      for (const index of stops) expect(snippet.body, snippet.id).toMatch(new RegExp(`\\$\\{${index}:`))
      expect(parsed.children.every(child => child instanceof Placeholder || child instanceof Variable || !child.toString().includes('${')), snippet.id).toBe(true)
    }
  })
  it('stay within bounds, with unique ids and one selected text per surround snippet', () => {
    expect(snippets.length).toBeLessThanOrEqual(snippetLimits.snippets)
    expect(new Set(snippets.map(snippet => snippet.id)).size).toBe(snippets.length)
    for (const snippet of snippets) {
      expect(snippet.body.length, snippet.id).toBeLessThanOrEqual(snippetLimits.bodyChars)
      expect(snippet.body.split('$TM_SELECTED_TEXT').length - 1, snippet.id).toBe(snippet.kind === 'surround' ? 1 : 0)
    }
    expect(snippets.find(snippet => snippet.id === 'surround.begin')?.body).toBe('BEGIN\n\t$TM_SELECTED_TEXT$0\nEND')
  })
  it('never carry a literal password', () => {
    for (const snippet of snippets) {
      for (const match of snippet.body.matchAll(/PASSWORD\s*=\s*N?'([^']*)'/gi)) expect(match[1], snippet.id).toMatch(/^\$\{\d+:[^}]*\}$/)
    }
    expect(snippets.some(snippet => /PASSWORD/i.test(snippet.body))).toBe(true)
  })
})

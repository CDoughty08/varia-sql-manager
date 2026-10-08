import { describe, expect, it } from 'vitest'
import { commandIds, paletteLabel } from '../src/shared/commands/catalog'
import { contextKeyNames } from '../src/shared/commands/context-keys'
import { renderCommandDocs } from '../src/shared/commands/docs'

// Regenerate after changing the catalogue, context keys, or reserved keys: npx vitest run tests/commands-docs.test.ts -u
describe('generated command documentation', () => {
  const docs = renderCommandDocs()
  it('keeps docs/commands.md in sync', async () => {
    await expect(docs).toMatchFileSnapshot('../docs/commands.md')
  })
  it('lists every command and context key', () => {
    for (const id of commandIds) expect(docs, id).toContain(`| \`${id}\` |`)
    for (const key of contextKeyNames) expect(docs, key).toContain(`| \`${key}\` |`)
    expect(docs).toContain(`## Commands (${commandIds.length})`)
    expect(paletteLabel('query.execute')).toBe('Query: Execute')
  })
  it('shows each platform\'s keys and marks native ones', () => {
    expect(docs).toContain('| New Query | `file.new` | Ctrl+N | Ctrl+N | ⌘N | `!documentBusy` | File › New Query |')
    expect(docs).toContain('| Redo | `edit.redo` | Ctrl+Y *, Ctrl+Shift+Z * | Ctrl+Y *, Ctrl+Shift+Z * | ⇧⌘Z * | Always | Edit › Redo |')
    expect(docs).toContain('| Execute | `query.execute` | F5 (`editorFocus`), Ctrl+Enter (`editorFocus`), Ctrl+E (`editorFocus`) | F5 (`editorFocus`), Ctrl+Enter (`editorFocus`), Ctrl+E (`editorFocus`) | F5 (`editorFocus`), ⌘↩ (`editorFocus`) |')
    expect(docs).toContain('| Toggle Word Wrap | `editor.toggleWordWrap` | Alt+Z | Alt+Z | — | Always; checked when `editorWordWrap` | View › Word Wrap |')
    expect(docs).toContain('| Uncomment Selection | `edit.uncommentLines` | Ctrl+K Ctrl+U * | Ctrl+K Ctrl+U * | ⌘K ⌘U * | `hasActiveDocument` | Edit › Uncomment Selection |')
    expect(docs).toContain('| Save Layout… | `layout.save` | — | — | — | Always | View › Save Layout…; Window › Save Window Layout… |')
  })
})

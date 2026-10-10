import { describe, expect, it } from 'vitest'
import { commandDescriptor, commandIds, paletteLabel } from '../src/shared/commands/catalog'
import { contextKeyNames } from '../src/shared/commands/context-keys'
import { renderCommandDocs } from '../src/shared/commands/docs'
import { contextMenuIds, menuIds, submenuIds, submenus, type SubmenuId } from '../src/shared/commands/menus'

// Regenerate after changing the catalogue, menus, context keys, or reserved keys: npx vitest run tests/commands-docs.test.ts -u
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
    expect(docs).toContain('| Redo | `edit.redo` | Ctrl+Y *, Ctrl+Shift+Z * | Ctrl+Y *, Ctrl+Shift+Z * | ⇧⌘Z * | Always | Edit › Redo; Text field context menu › Redo |')
    expect(docs).toContain('| Show Context Menu (not in the palette) | `workbench.showContextMenu` | Shift+F10, Menu | Shift+F10, Menu | ⇧F10 | `!quickInputVisible` | — |')
    expect(docs).toContain('Query tab context menu › Open Containing Folder (Windows, Linux only); Query tab context menu › Reveal in Finder (macOS only) |')
    expect(docs).toContain('| Execute | `query.execute` | F5 (`editorFocus`), Ctrl+Enter (`editorFocus`), Ctrl+E (`editorFocus`) | F5 (`editorFocus`), Ctrl+Enter (`editorFocus`), Ctrl+E (`editorFocus`) | F5 (`editorFocus`), ⌘↩ (`editorFocus`) |')
    expect(docs).toContain('| Toggle Word Wrap | `editor.toggleWordWrap` | Alt+Z | Alt+Z | — | Always; checked when `editorWordWrap` | View › Word Wrap |')
    expect(docs).toContain('| Uncomment Selection | `edit.uncommentLines` | Ctrl+K Ctrl+U * | Ctrl+K Ctrl+U * | ⌘K ⌘U * | `hasActiveDocument` | Edit › Uncomment Selection |')
    expect(docs).toContain('| Save Layout… | `layout.save` | — | — | — | Always | View › Save Layout…; Window › Save Window Layout… |')
    expect(docs).toContain('| Create Custom Theme… | `preferences.createTheme` | — | — | — | Always | View › Theme › Create Custom Theme… |')
  })
  it('lists every menu\'s items in order, title-bar menus first, with each context menu\'s use', () => {
    const menus = docs.slice(docs.indexOf('\n## Menus\n'), docs.indexOf('\n## Context keys'))
    const sections = menus.split('\n#### ').slice(1)
    expect(sections).toHaveLength(menuIds.length)
    expect(menus.indexOf('### Context menus')).toBeGreaterThan(menus.indexOf('#### Window (Alt+W)'))
    menuIds.forEach((menu, index) => {
      const section = sections[index]
      for (const id of commandIds.filter(id => commandDescriptor(id).menus?.some(placement => placement.menu === menu))) expect(section, `${menu}: ${id}`).toContain(`| \`${id}\` |`)
      // A dynamic title is documented by its pattern: Script … as names the selected object.
      const title = (id: SubmenuId) => submenus[id].dynamicTitle === 'scriptAs' ? 'Script … as' : submenus[id].title
      for (const id of submenuIds.filter(id => submenus[id].placements.some(placement => placement.menu === menu))) expect(section.replaceAll('**', ''), `${menu}: ${id}`).toContain(`| ${title(id)} › | Submenu: `)
    })
    for (const menu of contextMenuIds) expect(menus).toMatch(new RegExp(`#### .* \\(\`${menu.replace('.', '\\.')}\`\\)\n\nRight-click `))
    expect(menus).toContain('| `z_quit` | E**x**it | `window.close` | Windows only |')
    expect(menus).toContain('| `z_quit` | **Q**uit | `window.close` | Linux only |')
    expect(menus).toContain('| `0_connect` | **C**onnect… | `connection.connect` | `explorerNode == \'server\' \\|\\| explorerNode == \'background\'` |')
    expect(menus).toContain('| `3_file` | **O**pen Containing Folder | `file.revealInFolder` | Windows, Linux only |')
    expect(menus).toContain('| `3_file` | Reveal in Finder | `file.revealInFolder` | macOS only |')
    expect(menus).toContain('| `0_connection` | C**o**nnection › | Submenu: Query › Connection | Always |')
    expect(menus).toContain('| theme items | **D**ark, **L**ight, Follow **S**ystem | `preferences.setTheme` | Always |')
    expect(menus).toContain('| `4_window` | Minimize | Electron role `minimize` | macOS only |')
  })
})

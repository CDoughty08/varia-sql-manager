import { describe, expect, it } from 'vitest'
import { dialogEnter, type EnterTarget } from '../src/renderer/src/dialogs/dialog-keys'
import { propertyGridAttribute, visibleGridRows } from '../src/renderer/src/settings/grid-rows'
import type { GridGroup, GridRow } from '../src/renderer/src/settings/PropertyGrid'

const row = (key: string, label: string, extra: Partial<GridRow> = {}): GridRow => ({ key, label, description: '', control: 'text', value: '', changed: false, disabled: false, ...extra })
const keys = (groups: readonly GridGroup[]) => groups.map(group => [group.label, group.rows.map(item => item.key)])

describe('property grid rows', () => {
  const groups: GridGroup[] = [
    { label: 'Identity', rows: [row('name', 'Name'), row('identity', 'Identity Specification', { expanded: false }), row('seed', 'Identity Seed', { parent: 'identity' })] },
    { label: 'General', rows: [row('type', 'Data Type'), row('nulls', 'allow Nulls')] }
  ]
  it('keeps SSMS\'s categories in order, and shows a child row only while its parent is expanded', () => {
    expect(keys(visibleGridRows(groups))).toEqual([['Identity', ['name', 'identity']], ['General', ['type', 'nulls']]])
    const open = groups.map(group => ({ ...group, rows: group.rows.map(item => item.key === 'identity' ? { ...item, expanded: true } : item) }))
    expect(keys(visibleGridRows(open, 'categorized'))).toEqual([['Identity', ['name', 'identity', 'seed']], ['General', ['type', 'nulls']]])
  })
  it('lists every row in one unlabelled group by label, ignoring case, in SSMS\'s Alphabetical view', () => {
    expect(keys(visibleGridRows(groups, 'alphabetical'))).toEqual([[undefined, ['nulls', 'type', 'identity', 'name']]])
    const open = groups.map(group => ({ ...group, rows: group.rows.map(item => item.key === 'identity' ? { ...item, expanded: true } : item) }))
    expect(keys(visibleGridRows(open, 'alphabetical'))).toEqual([[undefined, ['nulls', 'type', 'identity', 'seed', 'name']]])
  })
})

describe('Enter in an object dialog', () => {
  /** An element whose ancestors match `inside` (selectors as a dialog page renders them). */
  const element = (tagName: string, inside: string[] = []): EnterTarget => ({ tagName, closest: selector => selector.split(', ').some(part => inside.includes(part)) ? {} : null })
  it('presses OK from a field or the dialog itself, as SSMS does', () => {
    expect(dialogEnter(element('INPUT'))).toBe('ok')
    expect(dialogEnter(element('FORM'))).toBe('ok')
    expect(dialogEnter(null)).toBe('ok')
  })
  it('leaves buttons and lists their own Enter', () => {
    expect(dialogEnter(element('BUTTON'))).toBe('native')
    expect(dialogEnter(element('SELECT', [`[${propertyGridAttribute}]`]))).toBe('native')
  })
  it('edits in place in a property grid, a grid, a list box or a table, never pressing OK', () => {
    for (const container of [`[${propertyGridAttribute}]`, '[role="grid"]', '[role="listbox"]', 'table']) expect(dialogEnter(element('INPUT', [container])), container).toBe('edit')
  })
})

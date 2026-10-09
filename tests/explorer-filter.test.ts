import { describe, expect, it } from 'vitest'
import { folderSpecs } from '../src/shared/explorer/catalog'
import { dateOpLabels, draftFilter, filterDraft, textOpLabels, type FilterDraft } from '../src/renderer/src/explorer/filter-form'

const tables = folderSpecs.tables.filter!, logins = folderSpecs.logins.filter!
const draft = (rows: Partial<{ [K in keyof FilterDraft]: Partial<FilterDraft[K]> }>): FilterDraft => {
  const base = filterDraft()
  return { name: { ...base.name, ...rows.name }, schema: { ...base.schema, ...rows.schema }, owner: { ...base.owner, ...rows.owner }, created: { ...base.created, ...rows.created } }
}

describe('Filter Settings form', () => {
  it('starts from the folder\'s filter, else Contains and Equals with no values, in SSMS\'s words', () => {
    expect(filterDraft()).toEqual({ name: { op: 'contains', value: '', value2: '' }, schema: { op: 'contains', value: '', value2: '' }, owner: { op: 'contains', value: '', value2: '' }, created: { op: 'equals', value: '', value2: '' } })
    expect(filterDraft({ name: { op: 'equals', value: 'Orders' }, created: { op: 'between', value: '2026-01-01', value2: '2026-02-01' } })).toMatchObject({
      name: { op: 'equals', value: 'Orders', value2: '' }, created: { op: 'between', value: '2026-01-01', value2: '2026-02-01' }, schema: { value: '' }
    })
    expect(Object.values(textOpLabels)).toEqual(['Contains', 'Equals', 'Does not contain'])
    expect(Object.values(dateOpLabels)).toEqual(['Equals', 'Less than', 'Less than or equal', 'Greater than', 'Greater than or equal', 'Between', 'Not between'])
  })
  it('sets the rows that have values, verbatim, combined; no values clears the filter', () => {
    expect(draftFilter(draft({}), tables)).toEqual({ ok: true, filter: undefined })
    expect(draftFilter(draft({ name: { value: ' Ord ' }, schema: { op: 'notContains', value: 'sys' }, created: { op: 'between', value: '2026-01-01', value2: '2026-01-31' } }), tables)).toEqual({ ok: true, filter: {
      name: { op: 'contains', value: ' Ord ' }, schema: { op: 'notContains', value: 'sys' }, created: { op: 'between', value: '2026-01-01', value2: '2026-01-31' }
    } })
    // A second date only counts for a range; a property the folder does not allow is ignored.
    expect(draftFilter(draft({ created: { op: 'lessThan', value: '2026-03-01', value2: '2026-04-01' }, schema: { value: 'dbo' } }), logins)).toEqual({ ok: true, filter: { created: { op: 'lessThan', value: '2026-03-01' } } })
  })
  it('names the row of each problem', () => {
    expect(draftFilter(draft({ created: { op: 'between', value: '2026-01-01' } }), tables)).toEqual({ ok: false, problems: { created: 'Enter the second date.' } })
    expect(draftFilter(draft({ created: { op: 'notBetween', value2: '2026-01-01' } }), tables)).toEqual({ ok: false, problems: { created: 'Enter the first date.' } })
    expect(draftFilter(draft({ created: { op: 'between', value: '2026-02-01', value2: '2026-01-01' } }), tables)).toEqual({ ok: false, problems: { created: 'The second date cannot be before the first.' } })
    expect(draftFilter(draft({ created: { value: '1700-01-01' } }), tables)).toEqual({ ok: false, problems: { created: 'Enter a date from 1753-01-01 to 9999-12-31.' } })
    expect(draftFilter(draft({ created: { value: '275760-01-01' } }), tables)).toEqual({ ok: false, problems: { created: 'Enter a date from 1753-01-01 to 9999-12-31.' } })
    expect(draftFilter(draft({ name: { value: 'x'.repeat(129) }, owner: { value: 'dbo' } }), tables)).toEqual({ ok: false, problems: { name: 'At most 128 UTF-16 code units.' } })
  })
})

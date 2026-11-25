// The TypeScript writer's hidden columns, held to what DiffChecks.cs asks of ResultTextWriter and ResultJobs: Save of a
// diff writes its marker and row numbers first, Copy writes shown values only (the fake backend formats both with it).
import { describe, expect, it } from 'vitest'
import { localPage, type LocalTableData } from '../src/shared/results/local-table'
import { copyText, exportText, type TextColumn } from '../src/shared/results/text-writer'

const table: LocalTableData = {
  columns: ['ItemId', 'Name', 'Price', 'Change', 'Old row', 'New row', 'Tone'].map(name => ({ name })),
  rows: [['2', 'b', '2', '−', '2', '2', 'removed'], ['2', 'b', '3', '+', '2', '2', 'added'], ['3', 'c', '3', '+', null, '3', 'added']]
}
const roles = [undefined, undefined, undefined, 'mark', 'leftRow', 'rightRow', 'tone']
const columns: TextColumn[] = table.columns.map((column, at) => ({ name: column.name, dataType: 'nvarchar', wire: 'text', ...roles[at] ? { role: roles[at] } : {} }))
const page = localPage(table)
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

describe('the TypeScript text writer and hidden columns', () => {
  it('saves a diff with Change, Old row and New row first and no tone', async () => {
    const writer = await exportText({ columns, kind: 'diff', pageAt: () => page, rows: 3, format: 'csv', headers: true, nullText: 'empty' })
    expect(decode(writer.out.bytes()).replace('﻿', '').split('\r\n')).toEqual(['Change,Old row,New row,ItemId,Name,Price', '−,2,2,2,b,2', '+,2,2,2,b,3', '+,,3,3,c,3', ''])
    // Any other result saves its shown columns only.
    const rows = await exportText({ columns, pageAt: () => page, rows: 3, format: 'csv', headers: true, nullText: 'empty' })
    expect(decode(rows.out.bytes()).replace('﻿', '').split('\r\n')[0]).toBe('ItemId,Name,Price')
  })
  it('copies shown values only, never the marker, row numbers or tone', async () => {
    const copied = await copyText({ columns, pageAt: () => page, available: 3, parts: [{ rows: [[0, 2]], columns: [[0, 6]] }], headers: true, crlf: false })
    expect(decode(copied.text)).toBe('ItemId\tName\tPrice\n2\tb\t2\n2\tb\t3\n3\tc\t3')
  })
  it('copies and saves a live table without its hidden identity columns', async () => {
    const live: LocalTableData = { columns: ['State', 'Job', 'Mine'].map(name => ({ name })), rows: [['DONE', 'job_1', 'true'], ['RUNNING', 'job_2', 'false']] }
    const liveColumns: TextColumn[] = live.columns.map((column, at) => ({ name: column.name, dataType: 'nvarchar', wire: 'text', ...at > 0 ? { role: 'hidden' as const } : {} }))
    const livePage = localPage(live)
    const copied = await copyText({ columns: liveColumns, pageAt: () => livePage, available: 2, parts: [{ rows: [[0, 1]], columns: [[0, 2]] }], headers: true, crlf: false })
    expect(decode(copied.text)).toBe('State\nDONE\nRUNNING')
    const saved = await exportText({ columns: liveColumns, pageAt: () => livePage, rows: 2, format: 'csv', headers: true, nullText: 'empty' })
    expect(decode(saved.out.bytes()).replace('﻿', '').split('\r\n')).toEqual(['State', 'DONE', 'RUNNING', ''])
  })
})

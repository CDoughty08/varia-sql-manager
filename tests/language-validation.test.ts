import { describe, expect, it } from 'vitest'
import { validateRequest, validateResult } from '../src/main/validation'
import { languageLimits } from '../src/shared/language-service'

const request = () => ({ documentId: crypto.randomUUID(), version: 1, text: 'SELECT N\'😀\';\r\nSELECT 1',
  context: { providerId: 'sqlserver', connectionId: crypto.randomUUID(), database: ' padded database ' }, position: { line: 1, character: 8 } })

describe('language-service IPC boundary', () => {
  it('bounds versioned diagnostics and excludes arbitrary server data', () => {
    const { position: _position, ...value } = request()
    expect(validateRequest('language.diagnostics', value)).toEqual(value)
    expect(() => validateRequest('language.diagnostics', { ...value, executable: 'anything' })).toThrow('Invalid request')
    const item = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, message: 'Missing column.', severity: 1, code: '207', source: 'SQL Tools Service' }
    expect(validateResult('language.diagnostics', { version: 1, items: [item], isIncomplete: false })).toMatchObject({ version: 1, items: [item] })
    for (const patch of [{ severity: 0 }, { severity: 5 }, { message: 'x'.repeat(languageLimits.diagnosticMessageCharacters + 1) },
      { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } }, { command: 'anything' }])
      expect(() => validateResult('language.diagnostics', { version: 1, items: [{ ...item, ...patch }], isIncomplete: false })).toThrow()
    expect(() => validateResult('language.diagnostics', { version: 1, items: Array(languageLimits.diagnostics + 1).fill(item), isIncomplete: true })).toThrow()
    expect(() => validateResult('language.diagnostics', { version: 0, items: [], isIncomplete: false })).toThrow()
  })
  it('accepts neutral provider contexts and zero-based UTF-16 positions without trimming names', () => {
    const value = request()
    expect(validateRequest('language.complete', value)).toEqual(value)
    expect(validateRequest('language.hover', { ...value, context: { providerId: 'bigquery', project: 'billing-project', dataset: 'data' }, position: { line: 0, character: 0 } })).toMatchObject({ context: { project: 'billing-project', dataset: 'data' } })
    expect(validateRequest('language.hover', { ...value, context: { providerId: 'postgresql', database: 'app', defaultSchema: 'public' } })).toMatchObject({ context: { defaultSchema: 'public' } })
  })
  it('rejects process paths, arbitrary methods, credentials and malformed or oversized documents', () => {
    const value = request()
    for (const patch of [{ executable: 'anything' }, { method: 'query/execute' }, { text: 'x'.repeat(languageLimits.documentCharacters + 1) },
      { version: 0 }, { documentId: 'file:///secret' }, { position: { line: -1, character: 0 } }, { position: { line: 0, character: 1.5 } },
      { context: { ...value.context, password: 'secret' } }, { context: { ...value.context, connectionString: 'secret' } },
      { context: { ...value.context, providerId: 'shell' } }]) expect(() => validateRequest('language.complete', { ...value, ...patch })).toThrow('Invalid request')
    expect(validateRequest('language.close', { documentId: value.documentId })).toEqual({ documentId: value.documentId })
    expect(() => validateRequest('language.close', { documentId: value.documentId, uri: 'file:///secret' })).toThrow('Invalid request')
  })
  it('validates the supported result subset and rejects executable server actions and oversized payloads', () => {
    const item = { label: 'Customer', kind: 7, textEdit: { newText: '[Customer]', range: { start: { line: 0, character: 7 }, end: { line: 0, character: 11 } } } }
    expect(validateResult('language.complete', { items: [item], isIncomplete: true })).toMatchObject({ items: [item] })
    expect(validateResult('language.hover', null)).toBeNull()
    expect(validateResult('language.status', { providers: [{ id: 'sqlserver', configured: false, completion: true, hover: true, reason: 'Configure the backend service.' }] })).toMatchObject({ providers: [{ configured: false }] })
    for (const patch of [{ command: { command: 'shell.execute' } }, { additionalTextEdits: [] }, { kind: 26 }, { label: 'x'.repeat(16_385) }])
      expect(() => validateResult('language.complete', { items: [{ ...item, ...patch }], isIncomplete: false })).toThrow('invalid answer')
    expect(() => validateResult('language.complete', { items: Array.from({ length: languageLimits.completionItems + 1 }, () => item), isIncomplete: false })).toThrow('invalid answer')
  })
  it('refreshes only a validated document context and rejects arbitrary server operations', () => {
    const { position: _position, ...refresh } = request()
    expect(validateRequest('language.refresh', refresh)).toEqual(refresh)
    for (const patch of [{ position: { line: 0, character: 0 } }, { ownerUri: 'file:///outside.sql' }, { method: 'connection/disconnect' },
      { context: { ...refresh.context, password: 'secret' } }, { documentId: 'bad-id' }, { text: 'x'.repeat(languageLimits.documentCharacters + 1) }])
      expect(() => validateRequest('language.refresh', { ...refresh, ...patch })).toThrow('Invalid request')
    expect(validateResult('language.refresh', { refreshed: true })).toEqual({ refreshed: true })
    expect(() => validateResult('language.refresh', { refreshed: true, command: 'run' })).toThrow('invalid answer')
  })
})

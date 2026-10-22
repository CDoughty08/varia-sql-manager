import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore } from '../src/main/connection-store'
import { validateRequest } from '../src/main/validation'
import { connectionDefaults, connectionKey, connectionLibrarySchema, connectionOptionsSchema, credentialBinding, savedConnection } from '../src/shared/connections'
import type { ConnectionOptions } from '../src/shared/contracts'
import { environmentPreset, environmentPresets, environmentSchema, environmentTag, maxEnvironmentLength } from '../src/shared/environments'
import { statusTones } from '../src/shared/theme/tones'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { applyEnvironment, parseEnvironment } from '../src/renderer/src/services/environments'
import { connectionInfo } from './fixtures/workbench'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const base: ConnectionOptions = { ...connectionDefaults('win32'), server: 'sql-prod-01', database: 'Sales' }

describe('environment tags', () => {
  it('shows Production as the red PROD tag, Staging in the info tone, and the rest without a state colour', () => {
    expect(environmentPresets).toEqual(['Production', 'Staging', 'Test', 'Development'])
    expect(environmentTag('Production')).toEqual({ tone: 'critical', text: 'PROD', description: 'Production environment' })
    expect(environmentTag('Staging')).toEqual({ tone: 'info', text: 'STAGING', description: 'Staging environment' })
    expect(environmentTag('Test')).toEqual({ tone: 'neutral', text: 'TEST', description: 'Test environment' })
    expect(environmentTag('Development')).toEqual({ tone: 'neutral', text: 'DEV', description: 'Development environment' })
    // A custom label shows as typed; one that spells a preset in another case is that preset, so "production" is red too.
    expect(environmentTag(' UAT-EU ')).toEqual({ tone: 'neutral', text: 'UAT-EU', description: 'UAT-EU environment' })
    expect(environmentTag('production')).toMatchObject({ tone: 'critical', text: 'PROD' })
    expect(environmentPreset('STAGING')).toBe('Staging')
    expect(environmentPreset('Prod')).toBeUndefined()
    for (const none of [undefined, '', '   ']) expect(environmentTag(none)).toBeUndefined()
    for (const preset of environmentPresets) expect(statusTones).toContain(environmentTag(preset)!.tone)
  })
  it('bounds a label to 32 visible characters, without control, format or line separator characters', () => {
    expect(environmentSchema.parse('  Production  ')).toBe('Production')
    expect(environmentSchema.safeParse('P'.repeat(maxEnvironmentLength)).success).toBe(true)
    for (const bad of ['', '   ', 'P'.repeat(maxEnvironmentLength + 1), 'PROD\u0007', 'PR\u202eOD', 'PR\u2028OD', 'PR\nOD', 'PR\u200bOD']) expect(environmentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})

describe('environment in the connection options', () => {
  it('is validated at the IPC boundary with the other options, and is optional', () => {
    for (const method of ['connections.connect', 'connections.databases', 'connections.preview']) {
      expect(validateRequest(method, { ...base, environment: 'Production' })).toMatchObject({ environment: 'Production' })
      expect(validateRequest(method, base)).not.toHaveProperty('environment')
      expect(() => validateRequest(method, { ...base, environment: 'x'.repeat(33) }), method).toThrow()
      expect(() => validateRequest(method, { ...base, environment: 42 }), method).toThrow()
    }
    expect(connectionOptionsSchema.safeParse({ ...base, environment: '\u0000' }).success).toBe(false)
  })
  it('is saved with the profile and read back, and a hand-edited file with a bad label is refused', () => {
    expect(savedConnection({ ...base, environment: 'Staging', password: 'x' })).toEqual({ ...base, environment: 'Staging' })
    const profile = { id: crypto.randomUUID(), options: { ...base, environment: 'Production' }, favorite: true, registered: false }
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [profile] }).success).toBe(true)
    expect(connectionLibrarySchema.safeParse({ version: 1, profiles: [{ ...profile, options: { ...base, environment: 'P'.repeat(40) } }] }).success).toBe(false)
  })
  it('labels the entry without making it another one or moving its remembered password', () => {
    expect(connectionKey({ ...base, environment: 'Production' })).toBe(connectionKey(base))
    expect(credentialBinding({ ...base, environment: 'Production' })).toBe(credentialBinding(base))
  })
  it('updates the history entry a connection made, keeping it recent and a favorite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'varia-environments-'))
    directories.push(directory)
    const path = join(directory, 'connections.json'), store = new ConnectionStore(path)
    const { id } = await store.rememberEntry({ ...base, environment: 'Production' })
    await store.save({ id, options: { ...base, environment: 'Production' }, favorite: true })
    const library = await store.save({ options: { ...base, environment: 'Staging' } })
    expect(library.profiles).toHaveLength(1)
    expect(library.profiles[0]).toMatchObject({ id, favorite: true, options: { environment: 'Staging' }, lastConnected: expect.any(String) })
    await store.save({ options: base })
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0].options).not.toHaveProperty('environment')
  })
})

describe('Set Connection Environment', () => {
  function service() {
    const connections = new ConnectionService()
    connections.add(connectionInfo('a'), { ...base, password: 'never-keep-this' })
    // Another connection to the same entry (a second Object Explorer connection), and one to another database.
    connections.add(connectionInfo('b'), base)
    connections.add(connectionInfo('c'), { ...base, database: 'master' })
    return connections
  }
  it('saves the label with the entry first, then shows it on every connection to that entry', async () => {
    const connections = service()
    const save = vi.fn(async () => ({ ok: true as const, value: { library: { version: 1 as const, profiles: [] }, savedPasswords: [] } }))
    expect(await applyEnvironment({ connections, save }, 'a', 'production')).toEqual({ ok: true, environment: 'Production' })
    expect(save.mock.calls).toEqual([[{ options: { ...base, environment: 'Production' } }]])
    expect(connections.getSnapshot().map(connection => connection.options.environment)).toEqual(['Production', 'Production', undefined])
    expect(JSON.stringify(save.mock.calls)).not.toContain('never-keep-this')
    // None removes it.
    expect(await applyEnvironment({ connections, save }, 'b', undefined)).toEqual({ ok: true })
    expect(save.mock.calls[1]).toEqual([{ options: base }])
    expect(connections.getSnapshot().map(connection => 'environment' in connection.options)).toEqual([false, false, false])
  })
  it('changes nothing on screen when the label is invalid, the server has gone, or saving fails', async () => {
    const connections = service()
    const save = vi.fn(async () => ({ ok: false as const, error: 'The saved connection library could not be written.' }))
    expect(await applyEnvironment({ connections, save }, 'a', '')).toEqual({ ok: false, error: 'Enter an environment label.' })
    expect(await applyEnvironment({ connections, save }, 'gone', 'Test')).toEqual({ ok: false, error: 'This server is no longer connected.' })
    expect(save).not.toHaveBeenCalled()
    expect(await applyEnvironment({ connections, save }, 'a', 'Test')).toEqual({ ok: false, error: 'The saved connection library could not be written.' })
    const thrown = vi.fn(async () => { throw new Error('IPC failed.') })
    expect(await applyEnvironment({ connections, save: thrown }, 'a', 'Test')).toEqual({ ok: false, error: 'IPC failed.' })
    expect(connections.getSnapshot().some(connection => connection.options.environment)).toBe(false)
  })
  it('parses the field: None, a preset by its own name, a custom label, or a Custom label left blank', () => {
    expect(parseEnvironment(undefined)).toEqual({ ok: true })
    expect(parseEnvironment('STAGING')).toEqual({ ok: true, environment: 'Staging' })
    expect(parseEnvironment(' UAT ')).toEqual({ ok: true, environment: 'UAT' })
    expect(parseEnvironment(' ')).toEqual({ ok: false, error: 'Enter an environment label.' })
    expect(parseEnvironment('x'.repeat(33))).toEqual({ ok: false, error: 'An environment label has at most 32 characters.' })
  })
  it('keeps the label on a lost connection, so Reconnect fills it in', () => {
    const connections = service()
    connections.markLostBefore(2)
    expect(connections.relabel('a', 'Production')).toEqual({ ...base, environment: 'Production' })
    expect(connections.get('b')).toMatchObject({ lost: true, options: { environment: 'Production' } })
    expect(connections.relabel('gone', 'Production')).toBeUndefined()
  })
})

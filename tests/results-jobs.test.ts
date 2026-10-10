import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exportDefaults, formatFromPath, jobSentences, removeExportLeftovers, ResultsJobHost, sanitizeFileName, supervisorJobs, type JobHostDeps, type JobsBackend } from '../src/main/results-jobs'
import { BackendError, sentences } from '../src/main/backend/errors'
import { BackendSupervisor } from '../src/main/backend/supervisor'
import type { ResultsCopyParams, ResultsExportParams, ResultsJobProgress, ResultsJobResult } from '../src/shared/contracts'
import { cancelReasons } from '../src/shared/ipc/wire/protocol'
import type { StreamSink } from '../src/main/backend/connection'

const jobId = () => crypto.randomUUID()
const part = { rows: [[0, Number.MAX_SAFE_INTEGER]], columns: [[0, 1]] }
const copyRequest = (patch: object = {}) => ({ jobId: jobId(), generation: 1, resultId: 7, headers: false, parts: [part], ...patch })
const saveRequest = (patch: object = {}) => ({ jobId: jobId(), generation: 1, resultId: 7, suggestedName: 'Query1-Result1', ...patch })
const done: ResultsJobResult = { rows: 2, bytes: 10, truncatedCells: 0, partial: false }
const failure = async (promise: Promise<unknown>): Promise<BackendError> => {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('The job succeeded.')
}

/** A backend whose copy and export the test settles, with every CANCEL and CREDIT recorded. */
function stub() {
  const calls: { method: 'copy' | 'export'; params: ResultsCopyParams | ResultsExportParams; sink?: StreamSink; onProgress(progress: { type: 'job.progress'; rowsDone: number; rowsTotal: number; bytes: number }): void; resolve(value: ResultsJobResult): void; reject(error: BackendError): void }[] = []
  const cancels: [number, number][] = [], credits: [number, number][] = []
  let nextId = 1
  const backend: JobsBackend = {
    readyGeneration: () => 1,
    copy: (_generation, params, o) => new Promise((resolve, reject) => { const id = nextId++; o.onSent(id); calls.push({ method: 'copy', params, sink: o.sink, onProgress: o.onProgress, resolve, reject }) }),
    export: (_generation, params, o) => new Promise((resolve, reject) => { const id = nextId++; o.onSent(id); calls.push({ method: 'export', params, onProgress: o.onProgress, resolve, reject }) }),
    credit: (_generation, id, bytes) => { credits.push([id, bytes]) },
    cancel: (_generation, id, reason) => { cancels.push([id, reason]) }
  }
  return { backend, calls, cancels, credits }
}
function host(patch: Partial<JobHostDeps> = {}) {
  const fake = stub()
  const clipboard: string[] = [], progress: ResultsJobProgress[] = []
  let now = 0
  const dialog = vi.fn<JobHostDeps['showSaveDialog']>(async () => ({ canceled: false, filePath: '/home/me/Documents/out.csv' }))
  const deps: JobHostDeps = {
    backend: fake.backend, owns: () => true, writeClipboard: text => { clipboard.push(text) }, showSaveDialog: dialog, documentsDir: () => '/home/me/Documents',
    progress: value => { progress.push(value) }, platform: 'linux', now: () => now, ...patch
  }
  return { jobs: new ResultsJobHost(deps), ...fake, clipboard, progress, dialog, tick: (ms: number) => { now += ms } }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ResultsJobHost copy', () => {
  it('rejects invalid requests and results the renderer does not own', async () => {
    const { jobs } = host({ owns: (generation, resultId) => generation === 1 && resultId === 7 })
    for (const value of [{}, copyRequest({ parts: [] }), copyRequest({ jobId: 'x' }), copyRequest({ extra: 1 })])
      expect(await failure(jobs.copy(value))).toMatchObject({ code: 'INVALID_REQUEST', message: jobSentences.invalid })
    expect(await failure(jobs.copy(copyRequest({ resultId: 8 })))).toMatchObject({ code: 'RESULT_UNAVAILABLE', message: sentences.resultUnavailable })
    expect(await failure(host({ backend: { ...stub().backend, readyGeneration: () => 2 } }).jobs.copy(copyRequest()))).toMatchObject({ code: 'RESULT_UNAVAILABLE' })
  })
  it('decodes the streamed UTF-8 across chunk boundaries, regrants credit, and writes the clipboard once', async () => {
    const { jobs, calls, credits, clipboard } = host({ platform: 'win32' })
    const copying = jobs.copy(copyRequest({ headers: true }))
    await settle()
    expect(calls[0].params).toEqual({ resultId: 7, parts: [part], headers: true, eol: 'crlf', maxBytes: 64 * 1024 * 1024 })
    const text = new TextEncoder().encode('\ufeffid\tname\r\n1\t😀 é')
    const split = text.indexOf(0xf0) + 2
    calls[0].sink!.data(1, text.slice(0, split).buffer)
    calls[0].sink!.data(2, text.slice(split).buffer)
    expect(clipboard).toEqual([])
    calls[0].resolve(done)
    expect(await copying).toEqual(done)
    expect(clipboard).toEqual(['\ufeffid\tname\r\n1\t😀 é'])
    expect(credits).toEqual([[1, split], [1, text.length - split]])
  })
  it('uses LF outside Windows', async () => {
    const { jobs, calls } = host({ platform: 'darwin' })
    void jobs.copy(copyRequest())
    await settle()
    expect((calls[0].params as ResultsCopyParams).eol).toBe('lf')
  })
  it('cancels a copy whose text runs past the cap and leaves the clipboard alone', async () => {
    const { jobs, calls, cancels, clipboard } = host()
    const copying = jobs.copy(copyRequest())
    await settle()
    const chunk = new Uint8Array(1024 * 1024).fill(65)
    for (let seq = 1; seq <= 66; seq++) calls[0].sink!.data(seq, chunk.slice().buffer)
    expect(cancels).toEqual([[1, cancelReasons.consumerGone]])
    calls[0].reject(new BackendError('CANCELLED', 'The operation was cancelled.'))
    expect(await failure(copying)).toMatchObject({ code: 'TOO_LARGE', message: jobSentences.copyTooLarge })
    expect(clipboard).toEqual([])
  })
  it('passes the backend\'s TOO_LARGE through, and a new copy cancels the running one', async () => {
    const { jobs, calls, cancels } = host()
    const first = jobs.copy(copyRequest())
    await settle()
    const second = jobs.copy(copyRequest())
    await settle()
    expect(cancels).toEqual([[1, cancelReasons.user]])
    calls[0].reject(new BackendError('CANCELLED', 'The operation was cancelled.'))
    expect(await failure(first)).toMatchObject({ code: 'CANCELLED' })
    calls[1].reject(new BackendError('TOO_LARGE', 'The selection is too large to copy (80 MB; the limit is 64 MB). Use Save Results As instead.'))
    expect(await failure(second)).toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('80 MB') })
  })
  it('leaves the clipboard alone when the backend finishes a copy cancelled late', async () => {
    const { jobs, calls, cancels, clipboard } = host()
    const request = copyRequest()
    const copying = jobs.copy(request)
    await settle()
    const encode = (text: string) => new TextEncoder().encode(text).buffer
    calls[0].sink!.data(1, encode('row0\nrow1\n'))
    expect(jobs.cancel(request.jobId)).toEqual({ cancelled: true })
    expect(cancels).toEqual([[1, cancelReasons.user]])
    // Its credit already covered the rest, so the backend sends it and answers as if the copy had run.
    calls[0].sink!.data(2, encode('row2\nrow3'))
    calls[0].resolve({ rows: 4, bytes: 19, truncatedCells: 0, partial: false })
    expect(await failure(copying)).toMatchObject({ code: 'CANCELLED', message: jobSentences.copyCancelled })
    expect(clipboard).toEqual([])
  })
  it('cancels by job id, forwards progress at most 4 times a second, and cancels everything on reset', async () => {
    const { jobs, calls, cancels, progress, tick } = host()
    const request = copyRequest()
    const copying = jobs.copy(request)
    await settle()
    for (let i = 0; i < 10; i++) { calls[0].onProgress({ type: 'job.progress', rowsDone: i, rowsTotal: 10, bytes: i * 10 }); tick(100) }
    expect(progress.map(item => item.rowsDone)).toEqual([0, 3, 6, 9])
    expect(progress[0]).toEqual({ jobId: request.jobId, kind: 'copy', rowsDone: 0, rowsTotal: 10, bytes: 0 })
    expect(jobs.cancel(crypto.randomUUID())).toEqual({ cancelled: false })
    expect(() => jobs.cancel('not-a-uuid')).toThrow()
    expect(jobs.cancel(request.jobId)).toEqual({ cancelled: true })
    expect(cancels).toEqual([[1, cancelReasons.user]])
    calls[0].reject(new BackendError('CANCELLED', 'The operation was cancelled.'))
    expect(await failure(copying)).toMatchObject({ code: 'CANCELLED' })
    void jobs.copy(copyRequest())
    void jobs.save(saveRequest())
    await settle()
    jobs.reset()
    expect(cancels.slice(1)).toEqual([[2, cancelReasons.consumerGone], [3, cancelReasons.consumerGone]])
  })
})

describe('ResultsJobHost save', () => {
  it('names the file, offers the formats with the requested one first, and returns only the file name', async () => {
    const { jobs, calls, dialog } = host()
    const saving = jobs.save(saveRequest({ format: 'tsv', suggestedName: 'Query:1/<Result>?*|"1\u0001' }))
    await settle()
    expect(dialog).toHaveBeenCalledWith({
      title: 'Save Grid Results', defaultPath: join('/home/me/Documents', 'Query_1__Result_____1_.txt'),
      filters: [{ name: 'Text (Tab delimited)', extensions: ['txt', 'tsv'] }, { name: 'CSV (Comma delimited)', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory']
    })
    // The chosen file's extension wins: out.csv is CSV, with the CSV defaults, and the path is used as chosen.
    expect(calls[0].params).toEqual({ resultId: 7, path: '/home/me/Documents/out.csv', format: 'csv', headers: true, nullText: 'empty', temporaryId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    calls[0].resolve(done)
    expect(await saving).toEqual({ ...done, fileName: 'out.csv', format: 'csv' })
  })
  it('reports a save as soon as its file is chosen, and names the file (never the path) in every report', async () => {
    const { jobs, calls, progress, tick } = host()
    const request = saveRequest()
    const saving = jobs.save(request)
    await settle()
    expect(progress).toEqual([{ jobId: request.jobId, kind: 'save', rowsDone: 0, rowsTotal: 0, bytes: 0, fileName: 'out.csv' }])
    // The throttle counts from that first report.
    calls[0].onProgress({ type: 'job.progress', rowsDone: 5, rowsTotal: 10, bytes: 50 })
    tick(250)
    calls[0].onProgress({ type: 'job.progress', rowsDone: 8, rowsTotal: 10, bytes: 80 })
    expect(progress.slice(1)).toEqual([{ jobId: request.jobId, kind: 'save', rowsDone: 8, rowsTotal: 10, bytes: 80, fileName: 'out.csv' }])
    calls[0].resolve(done)
    await saving
    // A cancelled dialog reports nothing.
    const cancelled = host({ showSaveDialog: async () => ({ canceled: true }) })
    await cancelled.jobs.save(saveRequest())
    expect(cancelled.progress).toEqual([])
  })
  it('chooses the format from the extension, keeps the requested one otherwise, and remembers the folder and format', async () => {
    expect([formatFromPath('/a/b.CSV'), formatFromPath('/a/b.txt'), formatFromPath('/a/b.tsv'), formatFromPath('/a/b.tab'), formatFromPath('/a/b.json'), formatFromPath('/a/b.xlsx'), formatFromPath('/a/b')])
      .toEqual(['csv', 'tsv', 'tsv', 'tsv', 'json', undefined, undefined])
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(128)
    expect(sanitizeFileName('a/b:c\u202egpj.\u2066x')).toBe('a_b_c_gpj._x')
    const paths = ['/data/out.json', '/data/out.dat']
    const dialog = vi.fn<JobHostDeps['showSaveDialog']>(async () => ({ canceled: false, filePath: paths.shift() }))
    const { jobs, calls } = host({ showSaveDialog: dialog })
    const first = jobs.save(saveRequest({ format: 'csv' }))
    await settle()
    expect(calls[0].params).toMatchObject({ format: 'json', nullText: exportDefaults.nullText.json })
    calls[0].resolve(done)
    await first
    const second = jobs.save(saveRequest())
    await settle()
    expect(dialog.mock.calls[1][0]).toMatchObject({ defaultPath: join('/data', 'Query1-Result1.json'), filters: [{ name: 'JSON', extensions: ['json'] }, expect.anything(), expect.anything(), expect.anything()] })
    expect(calls[1].params).toMatchObject({ path: '/data/out.dat', format: 'json' })
    calls[1].resolve(done)
    expect(await second).toMatchObject({ fileName: 'out.dat', format: 'json' })
  })
  it('answers null when the dialog is cancelled, JOB_BUSY while a save runs, and checks ownership again after the dialog', async () => {
    const cancelled = host({ showSaveDialog: async () => ({ canceled: true }) })
    expect(await cancelled.jobs.save(saveRequest())).toBeNull()
    expect(cancelled.calls).toEqual([])
    let owned = true
    const { jobs, calls } = host({ owns: () => owned })
    const saving = jobs.save(saveRequest())
    expect(await failure(jobs.save(saveRequest()))).toMatchObject({ code: 'JOB_BUSY', message: jobSentences.busy })
    await settle()
    calls[0].resolve(done)
    await saving
    owned = false
    expect(await failure(jobs.save(saveRequest()))).toMatchObject({ code: 'RESULT_UNAVAILABLE', message: sentences.resultUnavailable })
    // Closed while the dialog was open: nothing is exported.
    owned = true
    const late = host({ owns: () => owned, showSaveDialog: async () => { owned = false; return { canceled: false, filePath: '/x/y.csv' } } })
    expect(await failure(late.jobs.save(saveRequest()))).toMatchObject({ code: 'RESULT_UNAVAILABLE', message: jobSentences.closedBeforeSave })
    expect(late.calls).toEqual([])
  })
  it('turns EXPORT_FAILED tokens into sentences that name only the file', async () => {
    const expected: Record<string, string> = {
      ACCESS: 'Could not save the results: access to out.csv is denied.', DISK_FULL: 'Could not save the results: the disk is full.',
      IN_USE: 'Could not save the results: out.csv is open in another program.', NOT_FOUND: 'Could not save the results: the folder no longer exists.',
      IS_DIRECTORY: 'Could not save the results: out.csv is a folder.', IO: 'Could not save the results: out.csv could not be written.', OTHER: 'Could not save the results: out.csv could not be written.'
    }
    for (const [token, sentence] of Object.entries(expected)) {
      const { jobs, calls } = host()
      const saving = jobs.save(saveRequest())
      await settle()
      calls[0].reject(new BackendError('EXPORT_FAILED', token))
      expect(await failure(saving)).toMatchObject({ code: 'EXPORT_FAILED', message: sentence })
    }
  })
  it('removes the temporary file it named when the backend stops mid-save, and only then', async () => {
    const removeLeftovers = vi.fn(async () => {})
    const { jobs, calls } = host({ removeLeftovers })
    const failed = jobs.save(saveRequest())
    await settle()
    calls[0].reject(new BackendError('EXPORT_FAILED', 'IO'))
    await failure(failed)
    const lost = jobs.save(saveRequest())
    await settle()
    calls[1].reject(new BackendError('BACKEND_LOST', sentences.lost))
    expect(await failure(lost)).toMatchObject({ code: 'BACKEND_LOST' })
    expect(removeLeftovers.mock.calls).toEqual([['/home/me/Documents/out.csv', (calls[1].params as ResultsExportParams).temporaryId]])
    expect((calls[0].params as ResultsExportParams).temporaryId).not.toBe((calls[1].params as ResultsExportParams).temporaryId)
  })
  it('sweeps the temporary file, and the backup only once the target exists again', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varia-leftovers-'))
    try {
      const id = 'a'.repeat(32), target = join(folder, 'out.csv')
      await writeFile(join(folder, `.varia-${id}.tmp`), 'partial')
      await writeFile(join(folder, `.varia-${id}.bak`), 'old')
      await removeExportLeftovers(target, id, 60_000)
      // Without the target, the backup is the only copy of the old file.
      expect((await readdir(folder)).sort()).toEqual([`.varia-${id}.bak`])
      await writeFile(target, 'new')
      await removeExportLeftovers(target, id, 60_000)
      expect(await readdir(folder)).toEqual(['out.csv'])
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
})

describe('ResultsJobHost over the fake backend', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
  async function workbench() {
    const control = await mkdtemp(join(tmpdir(), 'varia-jobs-'))
    const supervisor = new BackendSupervisor({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/backend.mjs'), 'workbench'], cwd: process.cwd(), env: { ...process.env, VARIA_TEST_BACKEND_DIR: control }, packaged: false })
    cleanup.push(async () => { await supervisor.stop(); await rm(control, { recursive: true, force: true }) })
    const clipboard: string[] = [], progress: ResultsJobProgress[] = []
    let filePath = ''
    const jobs = new ResultsJobHost({ backend: supervisorJobs(supervisor), owns: () => true, writeClipboard: text => { clipboard.push(text) }, showSaveDialog: async () => ({ canceled: false, filePath }),
      documentsDir: () => control, progress: value => { progress.push(value) }, platform: 'linux' })
    const connection = await supervisor.request('connections.connect', { server: 'fake', database: 'master', authentication: 'sql', username: 'sa', password: 'x', trustServerCertificate: true })
    const execute = (sql: string) => supervisor.request('query.execute', { connectionId: connection.id, sessionId: crypto.randomUUID(), queryId: crypto.randomUUID(), database: 'master', sql, maxRows: 0, timeoutSeconds: 0, maxResultSets: 1000 })
    return { control, supervisor, jobs, clipboard, progress, execute, choose: (path: string) => { filePath = path } }
  }
  it('runs a directive script, copies its rows to the clipboard and saves them through a temporary file', async () => {
    const { control, jobs, clipboard, execute, choose } = await workbench()
    const summary = await execute('-- varia-fake: sets=W1*3000,N1*10,M1*3 messages=2 errors=1\nSELECT 1')
    expect(summary.resultSets.map(set => [set.columns.length, set.rowsAvailable, set.state])).toEqual([[8, 3000, 'complete'], [7, 10, 'complete'], [1, 1, 'complete'], [1, 1, 'complete'], [1, 1, 'complete']])
    expect(summary.messages).toEqual([{ text: 'Message 1', kind: 'info' }, { text: 'Message 2', kind: 'info' }, { text: 'Msg 50000, Level 16, State 1, Line 1\nFake error 1.', kind: 'error' }])
    expect(summary).toMatchObject({ status: 'failed', error: { code: 'SQL_ERROR' }, completedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}\+00:00$/) })
    const [w1, n1] = summary.resultSets
    expect(await jobs.copy(copyRequest({ resultId: w1.resultId, headers: true, parts: [{ rows: [[0, 1], [2999, Number.MAX_SAFE_INTEGER]], columns: [[0, 1]] }] }))).toMatchObject({ rows: 3, partial: false })
    expect(clipboard).toEqual(['id\tname\n0\tCustomer 0000000000 GmbH\n1\tCustomer 0000000001 GmbH\n2999\tSociété 0000002999 SARL'])
    expect(await failure(jobs.copy(copyRequest({ resultId: n1.resultId, parts: [{ rows: [[0, 5]], columns: [[0, 9]] }] })))).toMatchObject({ code: 'INVALID_PARAMS' })
    const target = join(control, 'w1.csv')
    choose(target)
    expect(await jobs.save(saveRequest({ resultId: w1.resultId }))).toMatchObject({ rows: 3000, fileName: 'w1.csv', format: 'csv' })
    const lines = (await readFile(target, 'utf8')).split('\r\n')
    expect([lines.length, lines[0], lines[1].split(',').slice(0, 2)]).toEqual([3002, '\ufeffid,name,created,amount,key,note,active,score', ['0', 'Customer 0000000000 GmbH']])
    expect((await readdir(control)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('cancels a held save, leaving no file and no temporary file', async () => {
    const { control, jobs, execute, choose } = await workbench()
    const [set] = (await execute('-- varia-fake: sets=W1*5000\nSELECT 1')).resultSets
    const target = join(control, 'held.json')
    choose(target)
    await mkdir(join(control, 'hold'), { recursive: true })
    await writeFile(join(control, 'hold', 'results.export'), '')
    const request = saveRequest({ resultId: set.resultId, format: 'json' })
    const saving = jobs.save(request)
    await expect.poll(async () => (await readdir(control)).some(name => name.endsWith('.tmp'))).toBe(true)
    expect(jobs.cancel(request.jobId)).toEqual({ cancelled: true })
    expect(await failure(saving)).toMatchObject({ code: 'CANCELLED' })
    await expect.poll(async () => (await readdir(control)).filter(name => name.endsWith('.tmp') || name === 'held.json')).toEqual([])
    expect(existsSync(target)).toBe(false)
  })
  it('removes the temporary file of a save whose backend stopped before it could', async () => {
    const { control, supervisor, jobs, execute, choose } = await workbench()
    const [set] = (await execute('-- varia-fake: sets=W1*5000\nSELECT 1')).resultSets
    choose(join(control, 'lost.csv'))
    await mkdir(join(control, 'hold'), { recursive: true })
    await writeFile(join(control, 'hold', 'results.export'), '')
    const saving = jobs.save(saveRequest({ resultId: set.resultId }))
    await expect.poll(async () => (await readdir(control)).some(name => name.endsWith('.tmp'))).toBe(true)
    // The fake backend exits at once on stdin EOF, as a killed one would, without removing its file.
    const failed = failure(saving)
    await supervisor.restart('manual')
    expect(await failed).toMatchObject({ code: 'BACKEND_LOST' })
    await expect.poll(async () => (await readdir(control)).filter(name => name.endsWith('.tmp') || name === 'lost.csv')).toEqual([])
  })
  it('streams rows at their rate while the script runs and stops them on cancel', async () => {
    const { supervisor } = await workbench()
    const events: string[] = []
    const queryId = crypto.randomUUID()
    const connection = await supervisor.request('connections.connect', { server: 'fake', database: 'master', authentication: 'sql', username: 'sa', password: 'x', trustServerCertificate: true })
    const running = supervisor.request('query.execute', { connectionId: connection.id, sessionId: crypto.randomUUID(), queryId, database: 'master', sql: '-- varia-fake: sets=W1*100000@20000\nSELECT 1', maxRows: 0, timeoutSeconds: 0 },
      { onEvent: event => { events.push(event.type === 'progress' ? 'progress:' + event.results[0].rowsAvailable : event.type) } })
    await expect.poll(() => events.filter(event => event.startsWith('progress')).length).toBeGreaterThan(2)
    await supervisor.request('query.cancel', { queryId })
    const summary = await running
    expect(summary).toMatchObject({ status: 'cancelled', resultSets: [{ state: 'complete', incomplete: true }] })
    expect(summary.resultSets[0].rowsRead).toBeLessThan(100_000)
    expect(events[0]).toBe('resultSet.opened')
    expect(summary.messages.at(-1)).toEqual({ text: 'The script was cancelled. Remaining batches were not executed.', kind: 'error' })
  })
})

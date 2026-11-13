import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { archiveUrl, downloadSqlToolsArchive, executableName, hostRid, markerName, prepareSqlToolsService, renamePreparedArtifact, safeArchiveEntries, sha256, sqlToolsManifest, sqlToolsServiceProblems, type SqlToolsManifest } from '../scripts/prepare-sqltools-service.mjs'

const folders: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
type PreparationMarker = { version: string; rid: string; archiveSha256: string; files: { path: string; sha256: string }[] }
async function fixture() {
  await mkdir('artifacts', { recursive: true })
  const root = await mkdtemp(join(resolve('artifacts'), 'sqltools-build-test-')); folders.push(root)
  await mkdir(join(root, 'build'))
  await writeFile(join(root, 'build', 'license.txt'), 'upstream MIT license')
  const manifest: SqlToolsManifest = { version: 'test-release', license: { file: 'build/license.txt', sha256: digest('upstream MIT license') },
    platforms: { 'win-x64': { archive: 'test.zip', sha256: digest('verified archive bytes') } } }
  const downloadArchive = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, 'verified archive bytes') })
  const extractArchive = vi.fn(async (_archive: string, folder: string) => {
    await Promise.all(['MicrosoftSqlToolsServiceLayer.exe', 'MicrosoftSqlToolsServiceLayer.dll', 'MicrosoftSqlToolsServiceLayer.runtimeconfig.json', 'Notice.txt'].map(file => writeFile(join(folder, file), `original ${file}`)))
    await mkdir(join(folder, 'vendor'))
    await writeFile(join(folder, 'vendor', 'LICENSE.txt'), 'preserved dependency notice')
  })
  return { root, manifest, downloadArchive, extractArchive, rid: 'win-x64' }
}

describe('SQL Tools Service download retries', () => {
  async function destination() {
    await mkdir('artifacts', { recursive: true })
    const root = await mkdtemp(join(resolve('artifacts'), 'sqltools-download-test-')); folders.push(root)
    return join(root, 'archive.partial')
  }
  const url = archiveUrl('linux-x64'), alternate = `${url}?download=1`
  it.each([408, 429, 500, 504])('retries HTTP %s from the same official asset within one shared budget', async status => {
    const output = await destination(), cancel = vi.fn(), firstBody = new ReadableStream({ cancel })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(firstBody, { status })).mockResolvedValueOnce(new Response('verified archive bytes'))
    vi.stubGlobal('fetch', fetch)
    await downloadSqlToolsArchive(url, output)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([url, alternate])
    expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal)
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readFile(output, 'utf8')).toBe('verified archive bytes')
  })
  it('retries a failed network connection without changing the pinned asset', async () => {
    const output = await destination(), fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response('archive bytes'))
    vi.stubGlobal('fetch', fetch)
    await downloadSqlToolsArchive(url, output)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([url, alternate])
    expect(await readFile(output, 'utf8')).toBe('archive bytes')
  })
  it('uses the pinned official asset API only after two transient release URL failures', async () => {
    const f = await fixture(), assetId = 42
    f.manifest.platforms[f.rid].assetId = assetId
    const fetch = vi.fn().mockImplementationOnce(async () => new Response('unavailable', { status: 504 }))
      .mockImplementationOnce(async () => new Response('unavailable', { status: 504 }))
      .mockResolvedValueOnce(new Response('verified archive bytes'))
    vi.stubGlobal('fetch', fetch)
    const output = await prepareSqlToolsService({ ...f, downloadArchive: undefined })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([archiveUrl(f.rid, f.manifest), `${archiveUrl(f.rid, f.manifest)}?download=1`,
      `https://api.github.com/repos/microsoft/sqltoolsservice/releases/assets/${assetId}`])
    expect(fetch.mock.calls[2][1].headers.Accept).toBe('application/octet-stream')
    expect(fetch.mock.calls.map(call => call[1].signal)).toEqual(Array(3).fill(fetch.mock.calls[0][1].signal))
    expect(f.extractArchive).toHaveBeenCalledOnce()
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
  })
  it('rejects official asset API bytes that fail the unchanged archive checksum before extraction', async () => {
    const f = await fixture()
    f.manifest.platforms[f.rid].assetId = 42
    const fetch = vi.fn().mockImplementationOnce(async () => new Response('unavailable', { status: 504 }))
      .mockImplementationOnce(async () => new Response('unavailable', { status: 504 }))
      .mockResolvedValueOnce(new Response('corrupt archive'))
    vi.stubGlobal('fetch', fetch)
    await expect(prepareSqlToolsService({ ...f, downloadArchive: undefined })).rejects.toThrow('SHA-256')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(f.extractArchive).not.toHaveBeenCalled()
    expect(await readdir(join(f.root, 'artifacts', 'sqltools-service-downloads'))).toEqual([])
  })
  it('refuses a terminal HTTP error without retrying', async () => {
    const output = await destination(), fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    await expect(downloadSqlToolsArchive(url, output, 42)).rejects.toThrow('HTTP 404')
    expect(fetch).toHaveBeenCalledOnce()
    await expect(access(output)).rejects.toThrow()
  })
  it('removes an interrupted stream before retrying, so partial bytes cannot prefix the archive', async () => {
    const output = await destination()
    let partialObserved = false
    const body = new ReadableStream({
      async pull(controller) {
        if (!partialObserved) {
          controller.enqueue(new TextEncoder().encode('partial archive'))
          await vi.waitFor(async () => { expect(await readFile(output, 'utf8')).toBe('partial archive') })
          partialObserved = true
          controller.error(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
        }
      }
    })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(body)).mockImplementationOnce(async () => {
      await expect(access(output)).rejects.toThrow()
      return new Response('complete archive')
    })
    vi.stubGlobal('fetch', fetch)
    await downloadSqlToolsArchive(url, output)
    expect(partialObserved).toBe(true)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([url, alternate])
    expect(await readFile(output, 'utf8')).toBe('complete archive')
  })
  it('stops after three transient failures and leaves no partial file', async () => {
    const output = await destination(), fetch = vi.fn().mockImplementation(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    await expect(downloadSqlToolsArchive(url, output)).rejects.toThrow('HTTP 503')
    expect(fetch.mock.calls.map(call => call[0])).toEqual([url, alternate, alternate])
    await expect(access(output)).rejects.toThrow()
  })
  it('keeps the download size limit terminal and removes its partial file', async () => {
    const output = await destination(), fetch = vi.fn().mockResolvedValueOnce(new Response('oversized archive', {
      headers: { 'Content-Length': String(256 * 1024 * 1024 + 1) }
    }))
    vi.stubGlobal('fetch', fetch)
    await expect(downloadSqlToolsArchive(url, output)).rejects.toThrow('download limit')
    expect(fetch).toHaveBeenCalledOnce()
    await expect(access(output)).rejects.toThrow()
  })
})

describe('verified SQL Tools Service artifact publication', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code })
  it('retries brief Windows sharing violations while publishing the same verified artifact', async () => {
    vi.useFakeTimers()
    const move = vi.fn().mockRejectedValueOnce(failure('EPERM')).mockRejectedValueOnce(failure('EBUSY')).mockRejectedValueOnce(failure('EACCES')).mockResolvedValue(undefined)
    const published = renamePreparedArtifact('verified.staging', 'distribution', 'win32', move)
    await vi.runAllTimersAsync()
    await expect(published).resolves.toBeUndefined()
    expect(move.mock.calls).toEqual(Array(4).fill(['verified.staging', 'distribution']))
  })
  it('bounds retries and preserves a persistent Windows publication failure', async () => {
    vi.useFakeTimers()
    const error = failure('EPERM'), move = vi.fn().mockRejectedValue(error)
    const published = expect(renamePreparedArtifact('verified.staging', 'distribution', 'win32', move)).rejects.toBe(error)
    await vi.runAllTimersAsync()
    await published
    expect(move).toHaveBeenCalledTimes(8)
  })
  it.each(['ENOENT', 'EXDEV', 'ENOTDIR', 'ENOSPC', 'EIO'])('does not retry a terminal %s publication error', async code => {
    const error = failure(code), move = vi.fn().mockRejectedValue(error)
    await expect(renamePreparedArtifact('verified.staging', 'distribution', 'win32', move)).rejects.toBe(error)
    expect(move).toHaveBeenCalledOnce()
  })
  it.each(['linux', 'darwin'] as const)('does not retry permission errors on %s', async platform => {
    const error = failure('EPERM'), move = vi.fn().mockRejectedValue(error)
    await expect(renamePreparedArtifact('verified.staging', 'distribution', platform, move)).rejects.toBe(error)
    expect(move).toHaveBeenCalledOnce()
  })
})

describe('bundled SQL Tools Service preparation', () => {
  it('pins all shipped targets to one immutable official release and preserves its verified MIT license', async () => {
    expect(sqlToolsManifest.version).toBe('6.0.20261104.1')
    expect(Object.keys(sqlToolsManifest.platforms).sort()).toEqual(['linux-x64', 'osx-arm64', 'osx-x64', 'win-x64'])
    for (const [rid, artifact] of Object.entries(sqlToolsManifest.platforms)) {
      expect(Number.isSafeInteger(artifact.assetId) && artifact.assetId! > 0).toBe(true)
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(archiveUrl(rid)).toBe(`https://github.com/microsoft/sqltoolsservice/releases/download/${sqlToolsManifest.version}/${artifact.archive}`)
      expect(artifact.archive).toBe(`Microsoft.SqlTools.ServiceLayer-${rid}-net10.0.${rid.startsWith('win-') ? 'zip' : 'tar.gz'}`)
    }
    expect(await sha256(sqlToolsManifest.license.file)).toBe(sqlToolsManifest.license.sha256)
    expect(sqlToolsManifest.license.source).toContain(`/${sqlToolsManifest.version}/license.txt`)
  })
  it('selects native targets and rejects unsupported hosts and unsafe archive paths', () => {
    expect([hostRid('win32', 'x64'), hostRid('linux', 'x64'), hostRid('darwin', 'arm64'), hostRid('darwin', 'x64')]).toEqual(['win-x64', 'linux-x64', 'osx-arm64', 'osx-x64'])
    expect(() => hostRid('linux', 'arm64')).toThrow('not bundled')
    expect(executableName('win-x64')).toBe('MicrosoftSqlToolsServiceLayer.exe')
    expect(executableName('osx-arm64')).toBe('MicrosoftSqlToolsServiceLayer')
    expect(safeArchiveEntries('./MicrosoftSqlToolsServiceLayer\nvendor/license.txt\n')).toHaveLength(2)
    for (const unsafe of ['../escape.dll', '/absolute', 'C:/escape', 'dir\\..\\escape', 'safe/../../escape', 'dir/file\u0000']) expect(() => safeArchiveEntries(unsafe), unsafe).toThrow('unsafe path')
  })
  it('preserves upstream/dependency notices and reuses verified output offline', async () => {
    const f = await fixture(), output = await prepareSqlToolsService(f)
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
    expect(await readFile(join(output, 'Notice.txt'), 'utf8')).toBe('original Notice.txt')
    expect(await readFile(join(output, 'LICENSE.SqlToolsService.txt'), 'utf8')).toBe('upstream MIT license')
    expect(await readFile(join(output, 'vendor', 'LICENSE.txt'), 'utf8')).toBe('preserved dependency notice')
    expect(await prepareSqlToolsService(f)).toBe(output)
    expect(f.downloadArchive).toHaveBeenCalledOnce(); expect(f.extractArchive).toHaveBeenCalledOnce()
  })
  it('detects altered runtime files and repairs from the verified archive cache', async () => {
    const f = await fixture(), output = await prepareSqlToolsService(f)
    await writeFile(join(output, 'MicrosoftSqlToolsServiceLayer.dll'), 'changed binary')
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toContain('SQL Tools Service file failed verification: MicrosoftSqlToolsServiceLayer.dll.')
    await prepareSqlToolsService(f)
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
    expect(f.downloadArchive).toHaveBeenCalledOnce(); expect(f.extractArchive).toHaveBeenCalledTimes(2)
    await writeFile(join(output, 'unexpected.dll'), 'unlisted binary')
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toContain('SQL Tools Service contains an unexpected file: unexpected.dll.')
    await prepareSqlToolsService(f)
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
  })
  it('rejects unverified downloads without extracting or publishing partial files', async () => {
    const f = await fixture()
    f.downloadArchive.mockImplementationOnce(async (_url, destination) => { await writeFile(destination, 'corrupt archive') })
    await expect(prepareSqlToolsService(f)).rejects.toThrow('SHA-256')
    expect(f.extractArchive).not.toHaveBeenCalled()
    await expect(access(join(f.root, 'artifacts', 'sqltools-service', f.rid))).rejects.toThrow()
    expect(await readdir(join(f.root, 'artifacts', 'sqltools-service-downloads'))).toEqual([])
  })
  it('requires the pinned hash for an explicitly supplied offline archive', async () => {
    const f = await fixture(), archivePath = join(f.root, 'offline.zip')
    await writeFile(archivePath, 'wrong archive')
    await expect(prepareSqlToolsService({ ...f, archivePath })).rejects.toThrow('SHA-256')
    expect(f.downloadArchive).not.toHaveBeenCalled(); expect(f.extractArchive).not.toHaveBeenCalled()
  })
  it('cleans interrupted extraction so a subsequent preparation recovers', async () => {
    const f = await fixture()
    f.extractArchive.mockImplementationOnce(async (_archive, output) => { await writeFile(join(output, 'partial.dll'), 'partial'); throw new Error('Extraction interrupted.') })
    await expect(prepareSqlToolsService(f)).rejects.toThrow('Extraction interrupted.')
    expect(await readdir(join(f.root, 'artifacts', 'sqltools-service'))).toEqual([])
    const output = await prepareSqlToolsService(f)
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
  })
  it('detects missing upstream notices and rejects a mismatched target marker', async () => {
    const f = await fixture(), output = await prepareSqlToolsService(f)
    await rm(join(output, 'Notice.txt'))
    expect((await sqlToolsServiceProblems(output, f.rid, f.manifest)).join(' ')).toContain('Notice.txt')
    await prepareSqlToolsService(f)
    const marker = JSON.parse(await readFile(join(output, markerName), 'utf8'))
    await writeFile(join(output, markerName), JSON.stringify({ ...marker, rid: 'osx-arm64' }))
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual(['SQL Tools Service does not match the pinned version and target.'])
  })
  it.each<[string, (marker: PreparationMarker) => unknown]>([
    ['null marker', () => null],
    ['array marker', () => []],
    ['invalid marker digest', marker => ({ ...marker, archiveSha256: 'not a digest' })],
    ['null file entry', marker => ({ ...marker, files: [null, ...marker.files.slice(1)] })],
    ['array file entry', marker => ({ ...marker, files: [[], ...marker.files.slice(1)] })],
    ['missing file digest', marker => ({ ...marker, files: marker.files.map(({ path }) => ({ path })) })],
    ['invalid file digest', marker => ({ ...marker, files: marker.files.map(file => ({ ...file, sha256: 'not a digest' })) })],
    ['duplicate file path', marker => ({ ...marker, files: [...marker.files, marker.files[0]] })],
    ['unsafe file path', marker => ({ ...marker, files: [{ ...marker.files[0], path: '../escape.dll' }, ...marker.files.slice(1)] })],
    ['multiline file path', marker => ({ ...marker, files: [{ ...marker.files[0], path: 'one.dll\ntwo.dll' }, ...marker.files.slice(1)] })]
  ])('repairs a prepared cache with a %s without downloading again', async (name, invalidate) => {
    const f = await fixture(), output = await prepareSqlToolsService(f)
    const marker = JSON.parse(await readFile(join(output, markerName), 'utf8')) as PreparationMarker
    await writeFile(join(output, markerName), JSON.stringify(invalidate(marker)))
    // Missing files and missing digests must never compare equal and make an empty cache look verified.
    if (name === 'missing file digest') await Promise.all(marker.files.map(file => rm(join(output, file.path))))
    expect((await sqlToolsServiceProblems(output, f.rid, f.manifest)).length).toBeGreaterThan(0)
    await expect(prepareSqlToolsService(f)).resolves.toBe(output)
    expect(await sqlToolsServiceProblems(output, f.rid, f.manifest)).toEqual([])
    expect(f.downloadArchive).toHaveBeenCalledOnce(); expect(f.extractArchive).toHaveBeenCalledTimes(2)
  })
  it('copies each target beside the backend and prepares it at development and packaging entry points', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    for (const script of ['dev', 'build', 'start', 'build:smoke']) expect(pkg.scripts[script], script).toContain('npm run sqltools:prepare')
    const builder = await readFile('electron-builder.yml', 'utf8')
    expect(builder).toContain('beforePack: build/sqltools-service-check.cjs')
    for (const rid of ['win', 'linux', 'osx']) expect(builder).toContain(`from: artifacts/sqltools-service/${rid}-\${arch}\n      to: sqltools-service`)
    const workflow = await readFile('.github/workflows/package.yml', 'utf8')
    expect(workflow).toContain('run: npm run sqltools:prepare -- --rid ${{ inputs.rid }}')
    expect(workflow.indexOf('Prepare pinned SQL Tools Service')).toBeLessThan(workflow.indexOf('Package application'))
    const smoke = await readFile('scripts/packaged-smoke.mjs', 'utf8')
    expect(smoke).toContain('delete env.VARIA_SQLTOOLS_SERVICE_PATH')
    expect(smoke).toContain('sqlToolsServiceProblems(resolve(resources, \'sqltools-service\'), hostRid())')
    expect(smoke).toContain('window.varia.languageComplete(')
    const release = await readFile('.github/workflows/release.yml', 'utf8')
    expect(release).toContain('      - scripts/prepare-sqltools-service.mjs\n')
    const ci = await readFile('.github/workflows/ci.yml', 'utf8')
    // These are workflow paths, not a test that launches the backend (check.mjs classifies backend consumers).
    const testAssembly = posix.join('backend', 'Varia.Backend.Tests', 'bin', 'Release', 'net11.0', 'Varia.Backend.Tests.dll')
    expect(ci).toContain(`if: matrix.group == 1 && (success() || failure()) && hashFiles('${testAssembly}') != ''`)
    expect(ci).toContain('dotnet run --no-build --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release -- --sql-language-live')
  })
})

import { describe, expect, it } from 'vitest'
import { droppedPathsSchema, fileArguments, LaunchQueue, maxLaunchFiles, secondInstanceSchema } from '../src/main/launch-files'
import { reloadPromptSchema } from '../src/main/sql-files'

const windows = { cwd: 'C:\\Work', defaultApp: false, platform: 'win32' as const }
const linux = { cwd: '/home/me/work', defaultApp: false, platform: 'linux' as const }

describe('files on the command line', () => {
  it('skips the executable and resolves the rest against the working directory', () => {
    expect(fileArguments(['C:\\Program Files\\Varia\\Varia.exe', 'orders.sql', '..\\shared\\a.sql', 'D:\\b.sql', '.'], windows))
      .toEqual(['C:\\Work\\orders.sql', 'C:\\shared\\a.sql', 'D:\\b.sql', 'C:\\Work'])
    expect(fileArguments(['/opt/varia/varia', 'orders.sql', '/tmp/a.sql'], linux)).toEqual(['/home/me/work/orders.sql', '/tmp/a.sql'])
  })
  it('skips the app path of an unpackaged run, after Chromium\'s and Playwright\'s switches', () => {
    expect(fileArguments(['electron.exe', '--inspect=0', '--remote-debugging-port=0', '.', 'a.sql'], { ...windows, defaultApp: true })).toEqual(['C:\\Work\\a.sql'])
    expect(fileArguments(['electron', 'out/main/index.js'], { ...linux, defaultApp: true })).toEqual([])
  })
  it('skips switches, and SSMS\'s with their values, which this version ignores', () => {
    const argv = ['ssms.exe', '-S', 'sql01', '-d', 'Sales', '-U', 'sa', '-P', 'secret', '-E', '-G', '-nosplash', '-resetsettings', '-?', '--allow-file-access-from-files', 'q.sql']
    expect(fileArguments(argv, windows)).toEqual(['C:\\Work\\q.sql'])
    // -log takes a file name only when one follows.
    expect(fileArguments(['ssms.exe', '-log', 'trace.log', 'q.sql'], windows)).toEqual(['C:\\Work\\q.sql'])
    expect(fileArguments(['ssms.exe', 'q.sql', '-log'], windows)).toEqual(['C:\\Work\\q.sql'])
    expect(fileArguments(['ssms.exe', '-log', '-nosplash', 'q.sql'], windows)).toEqual(['C:\\Work\\q.sql'])
    // Windows also writes them with a slash; elsewhere /S is a path.
    expect(fileArguments(['ssms.exe', '/S', 'sql01', '/nosplash', 'q.sql', '/x'], windows)).toEqual(['C:\\Work\\q.sql', 'C:\\x'])
    expect(fileArguments(['varia', '/S', 'q.sql'], linux)).toEqual(['/S', '/home/me/work/q.sql'])
  })
  it('names each file once (case folded on Windows) and at most 32', () => {
    expect(fileArguments(['varia.exe', 'a.sql', 'A.SQL', 'C:\\Work\\a.sql', 'b.sql'], windows)).toEqual(['C:\\Work\\a.sql', 'C:\\Work\\b.sql'])
    expect(fileArguments(['varia', 'a.sql', 'A.sql'], linux)).toEqual(['/home/me/work/a.sql', '/home/me/work/A.sql'])
    const many = fileArguments(['varia', ...Array.from({ length: 40 }, (_, index) => `${index}.sql`)], linux)
    expect(many).toHaveLength(maxLaunchFiles)
    expect(many.at(-1)).toBe('/home/me/work/31.sql')
  })
})

describe('files waiting for the page', () => {
  it('keeps files from before the window is ready, in order, once each, absolute only, at most 32', () => {
    const queue = new LaunchQueue()
    // macOS can send open-file before the app is ready.
    queue.add([process.platform === 'win32' ? 'C:\\a.sql' : '/a.sql'])
    queue.add([process.platform === 'win32' ? 'C:\\a.sql' : '/a.sql', 'relative.sql'])
    expect(queue.size).toBe(1)
    const absolute = (index: number) => process.platform === 'win32' ? `C:\\q\\${index}.sql` : `/q/${index}.sql`
    queue.add(Array.from({ length: 40 }, (_, index) => absolute(index)))
    expect(queue.size).toBe(maxLaunchFiles)
    const taken = queue.take()
    expect(taken[0]).toBe(process.platform === 'win32' ? 'C:\\a.sql' : '/a.sql')
    expect(taken[1]).toBe(absolute(0))
    expect(queue.take()).toEqual([])
  })
})

describe('file request schemas', () => {
  it('accepts at most 32 dropped paths of at most 4096 characters', () => {
    expect(droppedPathsSchema.safeParse(['C:\\a.sql']).success).toBe(true)
    for (const value of [[''], ['x'.repeat(4097)], Array.from({ length: 33 }, () => 'C:\\a.sql'), 'C:\\a.sql', [1]]) expect(droppedPathsSchema.safeParse(value).success).toBe(false)
  })
  it('reads a second instance\'s files strictly', () => {
    expect(secondInstanceSchema.safeParse({ files: ['/a.sql'] }).success).toBe(true)
    for (const value of [{ files: ['/a.sql'], cwd: '/' }, { files: Array.from({ length: 33 }, () => '/a.sql') }, { files: [''] }, null, ['/a.sql']]) expect(secondInstanceSchema.safeParse(value).success).toBe(false)
  })
  it('takes File changed\'s request by file id, never a name or path', () => {
    const fileId = '6f7f1d7a-3c0e-4b8e-9d55-2f0f0a6f0b11'
    expect(reloadPromptSchema.safeParse({ fileId, dirty: false, more: true }).success).toBe(true)
    for (const value of [{ fileId: 'C:\\a.sql', dirty: false, more: false }, { fileId, dirty: 'no', more: false }, { fileId, dirty: false, more: false, name: 'a.sql' }, { fileId, dirty: false }]) {
      expect(reloadPromptSchema.safeParse(value).success).toBe(false)
    }
  })
})

import { isAbsolute, posix, win32 } from 'node:path'
import { z } from 'zod'
import type { OpenedFiles } from '../shared/contracts'

/** Files opened at once from the command line, a second instance, macOS or a drop; more are refused or dropped. */
export const maxLaunchFiles = 32
const pathSchema = z.string().min(1).max(4096)
/** varia:files-dropped: what the preload read from a trusted drop. Main still requires absolute paths to regular files. */
export const droppedPathsSchema = z.array(pathSchema).max(maxLaunchFiles)
/** What a second instance hands the first (`requestSingleInstanceLock`'s additional data), which Chromium passes on as
 *  it was, unlike the command line it may reorder. */
export const secondInstanceSchema = z.object({ files: z.array(pathSchema).max(maxLaunchFiles) }).strict()
export type SecondInstanceData = z.infer<typeof secondInstanceSchema>

/** SSMS's command-line switches (ssms.exe -?): those that take the next argument, and those that stand alone. Varia
 *  ignores them for now; connecting from -S and -d is a follow-up. -log takes a file name only when one follows. */
const valued = new Set(['s', 'd', 'u', 'p'])
const flags = new Set(['e', 'g', 'nosplash', 'resetsettings', '?', 'log'])
export interface ArgumentOptions {
  readonly cwd: string
  /** Electron runs an app folder or script (`electron .`): the first argument that is not a switch is the app. */
  readonly defaultApp: boolean
  readonly platform?: NodeJS.Platform
}

/**
 * The files named on a command line: argv[0] (the executable) and, unpackaged, the app path are skipped, and so is every
 * switch: Chromium's and Electron's (`--inspect=0`), and SSMS's with their values (on Windows also written `/S`). The
 * rest resolve against `cwd`, without duplicates, at most 32. Whether each is a file is for the reader to find out.
 */
export function fileArguments(argv: readonly string[], options: ArgumentOptions): string[] {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const files: string[] = []
  let appSkipped = !options.defaultApp
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    const ssms = /^[-/]([A-Za-z?]+)$/.exec(argument)?.[1]?.toLowerCase()
    const switchLike = argument.startsWith('-') || (platform === 'win32' && ssms !== undefined && argument.startsWith('/') && (valued.has(ssms) || flags.has(ssms)))
    if (switchLike) {
      if (ssms && valued.has(ssms)) index++
      else if (ssms === 'log' && index + 1 < argv.length && !argv[index + 1].startsWith('-')) index++
      continue
    }
    if (!argument) continue
    if (!appSkipped) { appSkipped = true; continue }
    const absolute = path.resolve(options.cwd, argument)
    if (!files.some(file => platform === 'win32' ? file.toLowerCase() === absolute.toLowerCase() : file === absolute)) files.push(absolute)
    if (files.length === maxLaunchFiles) break
  }
  return files
}

/**
 * Paths waiting for a page that can take them: main adds those from the command line, a second instance, macOS's
 * open-file and drops, and takes them all once the workbench is ready. At most 32 wait; later ones are dropped.
 */
export class LaunchQueue {
  private paths: string[] = []
  add(paths: readonly string[]): void {
    for (const path of paths) if (this.paths.length < maxLaunchFiles && isAbsolute(path) && !this.paths.includes(path)) this.paths.push(path)
  }
  /** Everything waiting, in arrival order; the queue is empty afterwards. */
  take(): string[] { return this.paths.splice(0) }
  get size(): number { return this.paths.length }
}

/** What delivering waiting files needs of main: the page's state, and how files are read and handed to it. */
export interface LaunchDeliveryHost {
  /** Whether a page can take files now (it said it is ready, and the window is there). */
  ready(): boolean
  /** The page's generation, which a reload or crash moves on. */
  generation(): number
  /** Reads the files, reporting each that fails; never rejects. */
  open(paths: readonly string[]): Promise<OpenedFiles>
  send(opened: OpenedFiles): void
}

/**
 * Opens the files waiting for the page, once it is ready. A page that resets while they are read lost them, so they
 * wait again, and go to the next page at once when it became ready meanwhile (it found the queue empty then).
 */
export function deliverLaunchFiles(queue: LaunchQueue, host: LaunchDeliveryHost): void {
  if (!host.ready() || !queue.size) return
  const paths = queue.take(), generation = host.generation()
  void host.open(paths).then(opened => {
    if (generation === host.generation()) { host.send(opened); return }
    queue.add(paths)
    deliverLaunchFiles(queue, host)
  })
}

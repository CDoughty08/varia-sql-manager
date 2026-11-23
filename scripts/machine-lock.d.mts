/** Types for scripts/machine-lock.mjs, which tests/machine-lock.test.ts and tests/bench/setup.ts import. */
export type LockMode = 'shared' | 'exclusive'
export interface Held { release(): void, others: number }
export interface LockFsOps {
  linkSync?: (existingPath: string, newPath: string) => void
  readFileSync?: (path: string, encoding: 'utf8') => string
  statSync?: (path: string, options: { bigint: true }) => { ino: bigint, mtimeNs: bigint, birthtimeNs: bigint, size: bigint }
  unlinkSync?: (path: string) => void
  writeFileSync?: (file: string, data: string, options?: { flag?: string }) => void
}
export interface AcquireOptions {
  label?: string, env?: Record<string, string | undefined>, dir?: string, slots?: number, pollMs?: number, beatMs?: number
  graceMs?: number, fsOps?: LockFsOps
  log?: (text: string) => void, isAlive?: (pid: number) => boolean
  signal?: AbortSignal
}
export const heartbeatMs: number
export const staleMs: number
export const birthGraceMs: number
export function defaultDir(): string
export function lockEnabled(env?: Record<string, string | undefined>): boolean
export function sharedSlots(env?: Record<string, string | undefined>): number
export function entryMode(script?: string): LockMode | null
export function alive(pid: number): boolean
export function acquire(mode: LockMode, options?: AcquireOptions): Promise<Held>
export function holdForEntry(script?: string): Promise<Held>

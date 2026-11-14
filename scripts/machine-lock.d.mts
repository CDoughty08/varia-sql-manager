/** Types for scripts/machine-lock.mjs, which tests/machine-lock.test.ts and tests/bench/setup.ts import. */
export type LockMode = 'shared' | 'exclusive'
export interface Held { release(): void, others: number }
export interface AcquireOptions {
  label?: string, env?: Record<string, string | undefined>, dir?: string, slots?: number, pollMs?: number, beatMs?: number
  log?: (text: string) => void, isAlive?: (pid: number) => boolean
}
export const heartbeatMs: number
export const staleMs: number
export function defaultDir(): string
export function lockEnabled(env?: Record<string, string | undefined>): boolean
export function sharedSlots(env?: Record<string, string | undefined>): number
export function entryMode(script?: string): LockMode | null
export function alive(pid: number): boolean
export function acquire(mode: LockMode, options?: AcquireOptions): Promise<Held>
export function holdForEntry(script?: string): Promise<Held>

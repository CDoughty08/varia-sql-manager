/** Types for the shared Electron smoke fixtures. */
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication, expect as baseExpect } from '@playwright/test'

export const expect: typeof baseExpect
export function within<T, U = undefined>(promise: Promise<T>, ms: number, onTimeout?: () => U): Promise<T | U>
export const closeMs: number
export const pipeGraceMs: number
export const frameRateSwitch: string
type SmokeChild = Pick<ChildProcess, 'pid' | 'kill'> & Partial<Pick<ChildProcess, 'once' | 'off' | 'exitCode' | 'signalCode' | 'stdin' | 'stdout' | 'stderr'>>
export function releasePipesAfterExit(child: SmokeChild | null | undefined, graceMs?: number): () => void
export function boundedClose(application: { process(): SmokeChild | null | undefined }, close: () => unknown, ms?: number): Promise<void>
export const electron: { launch(options?: Record<string, unknown> & { motion?: boolean }): Promise<ElectronApplication> }

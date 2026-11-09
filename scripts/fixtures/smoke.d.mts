/** Types for the shared Electron smoke fixtures. */
import type { ElectronApplication, expect as baseExpect } from '@playwright/test'

export const expect: typeof baseExpect
export function within<T, U = undefined>(promise: Promise<T>, ms: number, onTimeout?: () => U): Promise<T | U>
export const closeMs: number
export const frameRateSwitch: string
export function boundedClose(application: { process(): { pid?: number; kill(signal?: NodeJS.Signals): boolean } | null | undefined }, close: () => unknown, ms?: number): Promise<void>
export const electron: { launch(options?: Record<string, unknown> & { motion?: boolean }): Promise<ElectronApplication> }

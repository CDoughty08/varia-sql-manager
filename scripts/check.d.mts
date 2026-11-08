/** Types for scripts/check.mjs, which tests/idle-waits.test.ts imports. */
import type { ChildProcess } from 'node:child_process'

export type CheckNode = string | { all: CheckNode[] } | { chain: CheckNode[] } | { gate: CheckNode, then: CheckNode }
export const needsBackend: string[]
export const steps: Record<string, string>
export function plan(options: { cpus: number, build?: boolean, skip?: string[] }): CheckNode
export const running: Set<{ name: string, started: number, output: Buffer[], child: ChildProcess }>
export function run(name: string, command: string, write?: (text: string) => void): Promise<{ name: string, code: number, seconds: number }>
export function flushRunning(write?: (text: string) => void): void

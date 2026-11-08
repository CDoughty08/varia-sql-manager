/** Types for scripts/smoke-shards.mjs, which tests/ci-workflow.test.ts and tests/smoke-shards.test.ts import. */
export function smokeSuites(): string[]
export const suiteSeconds: Readonly<Record<'linux' | 'windows', Readonly<Record<string, number>>>>
export const shardBudgetSeconds: number
export function platformSeconds(platform?: string): Readonly<Record<string, number>>
export function shardSuites(suites: readonly string[], count: number, seconds?: Readonly<Record<string, number>>): string[][]
export function suiteLimitSeconds(suite: string, platform?: string): number
export function runSuite(suite: string, limitMs: number, options?: { graceMs?: number, stdio?: 'inherit' | 'ignore', args?: readonly string[], signal?: AbortSignal }): Promise<{ status: number | null, signal: NodeJS.Signals | null, timedOut: boolean, interrupted: boolean, error?: Error }>

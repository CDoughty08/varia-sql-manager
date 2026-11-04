/** Types for scripts/smoke-shards.mjs, which tests/ci-workflow.test.ts and tests/smoke-shards.test.ts import. */
export function smokeSuites(): string[]
export const suiteSeconds: Readonly<Record<string, number>>
export function shardSuites(suites: readonly string[], count: number, seconds?: Readonly<Record<string, number>>): string[][]

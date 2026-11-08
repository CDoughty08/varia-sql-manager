/** Types for scripts/appimage-check.mjs, which tests/appimage-check.test.ts imports. */
export const searchPaths: readonly string[]
export function searchPathProblems(received: Readonly<Record<string, string | undefined>>, given: Readonly<Record<string, string | undefined>>, appDir: string): string[]
export function appRunExecutable(appRun: string): string
export function parseReport(text: string): { env: Record<string, string>, args: string[] }
export function appRunProblems(appRun: string, work: string): { problems: string[], noSandbox: string[] }
export const refusalText: string

/** Types for scripts/packaged-contents.mjs, which tests/packaging.test.ts imports. */
export function readAsar(path: string): Map<string, Buffer>
export function bareImports(code: string): string[]
export function asarProblems(contents: ReadonlyMap<string, Buffer>): string[]
export function isReadyToRun(path: string): boolean
export const readyToRunAssemblies: readonly string[]

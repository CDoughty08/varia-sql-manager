/** Types for scripts/fixtures/xvfb.mjs, which tests/smoke-xvfb.test.ts imports. */
export function underXvfb(env?: Record<string, string | undefined>, platform?: string): boolean
export const gpuSwitch: string
export function xvfbArgs(args: string[], env?: Record<string, string | undefined>, platform?: string): string[]

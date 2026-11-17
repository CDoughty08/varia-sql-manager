export interface SmokeWslOptions { setup: boolean, all: boolean, build: boolean, committed: boolean, distro: string | null, suites: string[] }
export function parseArgs(argv: string[]): SmokeWslOptions
export function suitePath(name: string): string
export function wslEnvNames(env: Record<string, string | undefined>): string

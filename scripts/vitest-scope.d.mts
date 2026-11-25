export function vitestFiles(testsDir?: string): string[]
export function classifyVitestIsolation(testsDir?: string): { stateless: string[]; isolated: string[] }
export function classifyVitestOsScope(testsDir?: string): { osSensitive: string[]; platformIndependent: string[] }

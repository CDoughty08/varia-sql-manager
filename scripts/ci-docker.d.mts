/** Types for the CI Docker container helper (scripts/ci-docker.mjs). */
export const sqlImage: string
export const bigQueryImage: string
export function pullWithRetry(image: string, options?: { attempts?: number; delayMs?: number; run?: (cmd: string, args: string[]) => void }): Promise<void>

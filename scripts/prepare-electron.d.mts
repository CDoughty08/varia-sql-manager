export const electronPreparationLimits: { readonly attempts: 3; readonly deadlineMs: 180000 }
export interface ElectronArchiveOptions {
  version: string
  platform: NodeJS.Platform
  arch: string
  checksums: Record<string, string>
  cacheRoot: string
  tempDirectory: string
  signal?: AbortSignal
  downloader?: { download(url: string, destination: string, options: { signal: AbortSignal }): Promise<void> }
}
export function seedElectronChecksums(cacheRoot: string, version: string, checksums: Record<string, string>): Promise<void>
export function downloadVerifiedElectron(options: ElectronArchiveOptions): Promise<string>
export function prepareElectron(options?: { projectRoot?: string; platform?: NodeJS.Platform; arch?: string; install?: boolean }): Promise<{
  version: string; platform: NodeJS.Platform; arch: string; cacheRoot: string; archivePath: string; installed: boolean
}>

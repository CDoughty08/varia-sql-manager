export interface SqlToolsManifest {
  version: string
  repository?: string
  release?: string
  license: { source?: string; file: string; sha256: string }
  platforms: Record<string, { archive: string; sha256: string; assetId?: number }>
}
export const sqlToolsManifest: SqlToolsManifest
export const markerName: string
export function executableName(rid: string): string
export function hostRid(platform?: NodeJS.Platform, arch?: string): string
export function archiveUrl(rid: string, manifest?: SqlToolsManifest): string
export function sha256(path: string): Promise<string>
export function renamePreparedArtifact(from: string, to: string, platform?: NodeJS.Platform, move?: typeof import('node:fs/promises').rename): Promise<void>
export function downloadSqlToolsArchive(url: string, destination: string, assetId?: number): Promise<void>
export function safeArchiveEntries(listing: string): string[]
export function sqlToolsServiceProblems(folder: string, rid?: string, manifest?: SqlToolsManifest): Promise<string[]>
export function prepareSqlToolsService(options?: {
  rid?: string; root?: string; archivePath?: string; manifest?: SqlToolsManifest
  downloadArchive?: (url: string, destination: string, assetId?: number) => Promise<void>
  extractArchive?: (archive: string, folder: string) => Promise<void>
}): Promise<string>

import current from '../../../release-notes/0.8.0.json'
import previous from '../../../release-notes/0.7.0.json'
import { compareVersions } from '../updates'
import { releaseNotesSchema, type ReleaseNotes } from './schema'

/** Explicit imports keep the published, reviewed records bundled for offline reading. Never include Unreleased. */
export const bundledReleaseNotes: readonly ReleaseNotes[] = [current, previous].map(value => releaseNotesSchema.parse(value)).sort((a, b) => compareVersions(b.version, a.version))
export const releaseNotesFor = (version: string | undefined): ReleaseNotes | undefined => bundledReleaseNotes.find(record => record.version === version)

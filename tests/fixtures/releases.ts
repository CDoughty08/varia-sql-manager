import type { ReleaseNotes } from '../../src/shared/releases/schema'

/** Publication fixtures stay independent of the application's latest release and editorial copy. */
export function releaseRecord(version = '1.2.3'): ReleaseNotes {
  return {
    schema: 1, version, releasedOn: '2026-01-02', summary: 'An update for everyday work.',
    changes: [
      { category: 'added', title: 'A new capability', text: 'A useful behavior is now available.' },
      { category: 'limits', title: 'Availability', text: 'This capability requires a supported server.' }
    ]
  }
}

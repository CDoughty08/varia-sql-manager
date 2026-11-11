// Render the reviewed record for a tag. The app bundles these same records; GitHub never substitutes commit lists.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { releaseNotesMarkdown, releaseNotesSchema, releaseVersionSchema } from '../src/shared/releases/schema.ts'
import { compareVersions, updateRepository } from '../src/shared/updates.ts'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function readRecord(version, root) {
  const path = join(root, 'release-notes', `${version}.json`)
  if ((await stat(path)).size > 131072) throw new Error('Release notes exceed the content size limit.')
  const record = releaseNotesSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (record.version !== version) throw new Error('The release record must match the requested version.')
  return record
}

export async function loadReleaseNotes(tag, root = project) {
  const version = releaseVersionSchema.parse(tag.replace(/^v/, ''))
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (version !== metadata.version) throw new Error('The release tag must match package.json version.')
  return readRecord(version, root)
}

/** Keep the hand-written Unreleased section and older-history link; published prose has one producer. */
export async function syncPublishedChangelog(root = project) {
  const path = join(root, 'CHANGELOG.md'), before = await readFile(path, 'utf8')
  const firstRelease = before.search(/\n## \[\d+\.\d+\.\d+/)
  const earlier = /\n## Earlier releases\n([\s\S]*?)(?=\n\[Unreleased\]:|$)/.exec(before)?.[0].trim()
  if (firstRelease < 0 || !earlier) throw new Error('Changelog must contain published releases and an Earlier releases section.')
  const records = []
  for (const file of (await readdir(join(root, 'release-notes'))).filter(file => file.endsWith('.json'))) {
    const version = releaseVersionSchema.parse(file.slice(0, -5))
    records.push(await readRecord(version, root))
  }
  records.sort((a, b) => compareVersions(b.version, a.version))
  if (!records.length) throw new Error('No published release records.')
  const repository = `https://github.com/${updateRepository.owner}/${updateRepository.repo}`
  const references = [`[Unreleased]: ${repository}/compare/v${records[0].version}...HEAD`, ...records.map(record => `[${record.version}]: ${repository}/releases/tag/v${record.version}`)]
  const after = [before.slice(0, firstRelease).trimEnd(), ...records.map(record => releaseNotesMarkdown(record, 'changelog').trimEnd()), earlier, references.join('\n')].join('\n\n') + '\n'
  await writeFile(path, after)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, destination] = process.argv.slice(2)
  if (tag === '--changelog') await syncPublishedChangelog()
  else {
    if (!tag || !destination) throw new Error('Usage: node scripts/release-notes.mjs <tag> <output.md> | --changelog')
    await writeFile(destination, releaseNotesMarkdown(await loadReleaseNotes(tag)))
  }
}

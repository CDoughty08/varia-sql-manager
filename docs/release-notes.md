# Release Notes

**Help > Release Notes** and the command palette open a read-only workbench tab for the running version. About's
Release Notes button closes the dialog and opens that tab. The version picker offers the releases bundled with this
copy, with the running version marked **installed**. Section navigation and keyboard paging use the shared document
frame. Notes can be read without a server connection, a working SQL backend or a network connection.

An update notification's **Release notes** action opens the exact version that notification advertised. If it is not
bundled, the tab says so. It offers installed-version notes when those are bundled and keeps **Release Downloads**
available. It never substitutes an older release under the requested version's heading. Opening missing notes does
not start a download, check the network or prevent updating. Development builds distinguish published notes from work
done since that release; Unreleased content is not presented as a published release.

**Release Downloads** is a separate command that opens the fixed GitHub releases page, also used where self-update is
unsupported (macOS included) and for update-error remedies. Checking, downloading, verification and installation belong
to the updater ([updates](updates.md)).

The tab has no SQL model, connection or save operation. It reuses one tab for subsequent requests. Reopening the same
release preserves its section and scroll position; choosing a different release starts at its first section. Closing
the tab releases that selection. State stays only in memory while open and is not restored by hot exit.

## Content and release preparation

`release-notes/<version>.json` is the reviewed source for published user-facing content. The application imports those
records explicitly in `src/shared/releases/catalog.ts`. The same bounded, strict schema and Markdown exporter in
`src/shared/releases/schema.ts` produce public GitHub summaries and the published sections of CHANGELOG.md.

Write the benefit, the behavior a user can see and any material prerequisites or limits. Use short titles and plain
paragraphs. Include relevant limits beside the feature or in **Things to know**. Leave implementation details, commit
lists, internal refactors and dependency inventories in engineering documentation. Content fields contain no HTML,
arbitrary links or executable examples. React renders text; no HTML or Markdown renderer is involved in the app.

Feature PRs maintain CHANGELOG.md's **Unreleased** section and affected user docs. At release preparation:

1. Review Unreleased against the behavior that will ship. Curate a new record with the exact package/tag version and
   release date. Use the schema's added, changed, fixed and limits categories; do not move pending work into an old record.
2. Add its explicit import to the bundled catalog. Update the package version as
   [Cutting a release](#cutting-a-release) describes. Clear only the Unreleased items included in this release.
3. Run `node scripts/release-notes.mjs --changelog`. It preserves Unreleased and the older-history link while regenerating
   published prose and release links from the records. Do not edit generated published sections by hand.
4. Preview the public body with `node scripts/release-notes.mjs v<version> artifacts/release-notes.md`, review the in-app
   reader, and run `npm run check`. Normal checks load the actual archive through the publishing validator, including
   each file's version/name match and byte limit, require it to equal the bundled records, check the package version's
   notes and compare the generated changelog. Publication tests use synthetic records and exercise a subsequent release;
   Electron checks derive installed/history expectations from the archive. A new release does not require editing test
   prose. The publishing command refuses missing, oversized, invalid or mismatched records.

Tag publication uses this compiled body with `gh release create --notes-file`, replacing automatic commit-list notes.
Published records are immutable: feature PRs edit Unreleased, and a correction belongs in the next release. Bundled
history starts at 0.7.0; earlier history is linked from CHANGELOG.md. Adding a release needs only data and a catalog
import, no page components or routes.

## Cutting a release

Release builds package and smoke-test every push to main, and pull requests that change packaging ([CI](ci.md)).

1. Update `package.json` and `package-lock.json` to the new version together, with the release record and changelog
   prepared as above, and merge.
2. Push the matching tag, `v<version>` (for example `v0.7.0` for `0.7.0`). The publishing step refuses a tag that differs
   from `package.json`'s version or has no release record.
3. The tag builds every platform. Once the builds and their packaged-app smoke checks pass, the workflow publishes a
   GitHub Release with the installers, the update manifests (`varia-update-v2.json`, which installed copies check, and
   `varia-update.json` for copies up to 0.7.0) and the curated notes. A version with a prerelease suffix (such as
   `v0.7.0-beta.1`) publishes a prerelease.

An existing release is never overwritten: resolve or remove it before rerunning the release job. To get installers
without a release, run the **Release builds** workflow manually; its installers stay available as workflow artifacts
for seven days.

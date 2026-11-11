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

**Release Downloads** is a separate command that opens the existing fixed GitHub releases destination. Unsupported
self-updates, including macOS, and update-error remedies still use that browser destination. Checking, downloading,
verification and installation remain owned by the updater and its existing manifests.

The tab has no SQL model, connection or save operation. It reuses one tab for subsequent requests, releases its
selection on close and keeps section selection only in memory while open. It is not restored by hot exit.

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
2. Add its explicit import to the bundled catalog. Update the package version through the normal release process.
   Clear only the Unreleased items included in this release.
3. Run `node scripts/release-notes.mjs --changelog`. It preserves Unreleased and the older-history link while regenerating
   published prose and release links from the records. Do not edit generated published sections by hand.
4. Preview the public body with `node scripts/release-notes.mjs v<version> artifacts/release-notes.md`, review the in-app
   reader, and run `npm run check`. Tests require every versioned record to be bundled, the package version to have notes
   and the generated changelog to match. The publishing command refuses missing, oversized, invalid or mismatched records.

Tag publication uses this compiled body with `gh release create --notes-file`, replacing automatic commit-list notes.
Published records are immutable. Future feature PRs edit Unreleased, and a correction belongs in the next release.
This change does not rewrite already-published GitHub releases. The initial bundled history covers 0.7.0 and 0.8.0;
earlier history remains linked from CHANGELOG.md. Remote note fetching, first-run opening and reading-progress storage
are separate features. Adding a release requires data and a catalog import, without adding page components or routes.

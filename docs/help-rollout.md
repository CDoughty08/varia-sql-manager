# Help implementation boundaries

Deliver help as independently reviewable changes, based on main after the previous dependent change merges. The
standalone design mocks remain design references and are not application code.

| PR | Included | Dependency and boundary |
| --- | --- | --- |
| About Varia | Help/palette and macOS app-menu entry, version/platform, current update state, support details, fixed project/support links, focus handling and checks. | Reuses the updater and the existing external Release Notes action. No guide routing, remote content or new SQL backend methods. |
| Curated release notes | Versioned, bundled user-focused release content, an in-app reader, exact-version/unavailable states and a separate release-download action. | Can reuse About. Preserve manual-download/error fallbacks and existing update manifests. Introduce reviewed release-content assembly rather than parsing GitHub commit lists at runtime. |
| Getting Started foundation | Read-only Help document route, typed guide registry, contextual command/key/setting/gesture references, first connection/query/results guides and shared sample components. | Reuse the existing stores and document kit. Add catalogue/reference checks and documentation-impact guidance. No automatic SQL execution, remote guide loader or second settings store. |
| Guide expansion | Additional workflow guides, their synthetic demonstrations and meaningful content checks, grouped into small feature-area PRs. | Uses the registry and shared sample families. Describe the UI that actually ships, its prerequisites and persistence limits. |

Future-version note fetching, automatic first-run opening and persistent reading progress require separate proposals
with explicit network, versioning and storage decisions. They are not prerequisites for opening About or reading
bundled help. Keep published notes immutable and keep Unreleased content separate from the installed version.

For each feature PR, update the affected hand-written docs and Unreleased summary, regenerate changed catalogues and
record guide/example impact or a concrete no-impact reason. The feature author owns those edits; release preparation
owns the final versioned summary. The wider help-authoring policy and registry checks can ship separately from the
About implementation so this first PR does not absorb the design prototypes or an unimplemented tutorial framework.

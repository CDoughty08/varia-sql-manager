# Maintaining user help

Feature authors own documentation impact in the feature PR. Update affected README/docs, guide prose and samples,
and the Unreleased changelog, or give a specific no-impact reason in the PR description. Release preparation owns
the versioned release summary; never add new behavior to a published release record. AGENTS.md delegates this policy
to CLAUDE.md so Codex and Claude receive the same instructions.

## Register a guide

1. Add one stable ID to `src/shared/help/catalog.ts`, with a user goal, concise summary, search keywords, ordered
   sections, related IDs and typed command/setting/gesture references. List real `sourceAreas` to help future authors
   find affected guides. This map is advisory; a source edit alone does not prove prose needs to change.
2. Add `src/renderer/src/help/guides/<id>.tsx`, exporting a default component accepting `GuideProps`. Use `GuidePage`
   with the registered ID and content for every section. Its content keys are type checked. Vite discovers and
   lazily loads the file; no additional route or renderer registration is needed. `HelpDocument` owns the stable
   frame and navigation controls, including focus when its tab remounts; `GuidePage` supplies its section body.
   Guide modules must not focus themselves when they finish loading: the navigation request already owns focus,
   and the user may have moved elsewhere.
   A rejected lazy import stays failed for the window's lifetime; recovery directs the reader to other guides or a
   restart, rather than promising that reopening the same page retries it.
3. Use `CommandRef`, `SettingRef` and `GestureRef` for current names, paths, keys and values. Declare those references
   in the catalog. Do not transcribe default key strings or use the reader's current Help focus to resolve them.
   A new lesson context belongs in the shared references helper, with checks for focus flags and scope precedence.
4. Prefer ordinary JSX prose and the small sample families in `Samples.tsx`. Reuse actual pure domain helpers
   where appropriate (authentication uses the production catalog). Samples are explicitly fictional, bounded,
   keyboard usable and text based. They never run SQL, collect credentials or instantiate a second workbench.
   State the sample's assumptions and which settings it honors. Prefer examples whose behavior remains correct under
   the other supported settings: the results sample sorts numeric ranks, independent of the text-sort mode, and its
   copy explanation follows the applied header option. Test nondefault settings and actual output ordering.
   Add a new sample family only when an existing family cannot explain the workflow; test its meaningful behavior.
5. Run `tests/getting-started.test.ts`, typecheck, and `npm run check` before committing. The registry check loads every
   guide and verifies module parity, related links, section uniqueness, real source paths and declared references.
   It intentionally does not snapshot prose: reviewers still check correctness, prerequisites, failure remedies,
   persistence limits and whether the explanation helps the user finish their task. `tests/getting-started-loading.test.ts`
   exercises delayed/rejected modules, recovery focus, closing during a load, tab reflow and settings-sensitive samples.
   Scroll checks include pointer input on nested content and Tab entry from the section list, as well as column input.

## Verify behavior

Guides use the existing document provider/frame, catalogs, settings store and effective shortcut/gesture services.
There is no help-specific preference store, remote loader, MDX compiler or progress database. Preserve that boundary.
Commands in prose are passive references; real entry points use catalog commands and clearly describe their effect.

`scripts/fixtures/help.mjs` shares the updates smoke launch. It checks menu/palette navigation, guide search, lazy page
focus, samples, live shortcut/gesture/setting changes, setting-page navigation, singleton tab behavior and screenshots.
The same launch verifies a popout palette brings Help into the main window. Add meaningful cases there when needed;
do not create a new launch/job for every page. Check narrow layouts, light/dark themes, keyboard use and reduced
motion. No guide animation is required to understand these samples.

When changing behavior, search the catalog's dependency IDs and source paths first, then read affected guide text and
sample behavior against the shipped code. Tests detect broken references, not semantic drift. Include that review in
the PR's documentation-impact note. Keep feature guides current; keep published release notes historical.

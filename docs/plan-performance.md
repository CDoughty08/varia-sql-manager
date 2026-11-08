# Execution plan performance

Issue #161 was rechecked against `origin/main` at `8bad3c5a` (including the execution-plan foundation through `142858b0`). Hidden output could prepare plans; remounts repeated reads, parsing and ELK; the ordered layered layout was super-linear; label slots followed spatial-query positions and retained their high-water mark.

The viewer now waits for both pane visibility and intersection in its owning document. Hiding output unmounts its viewer and releases Pixi; showing it reuses bounded parsed documents and layouts. A Graph/XML or document-tab switch uses the same caches. A live counter update continues to update the existing canvas without layout or renderer replacement. Streaming adds reuse earlier parsed sources and keep the displayed statements until the combined preparation is ready.

Rendering preparation is owned by the workbench, independently of retained plan snapshots:

- Parsed LRU: 64 entries, 20,000 operators, 16 Mi serialized text units. Keys include owner, source identity and document revision. It keeps parsed models and XML lengths, not XML strings. Concurrent readers share preparation; the last departing reader cancels its read. Failed and cancelled work is never cached.
- Layout LRU: 32 entries, 20,000 operators, 4 Mi weighted units for topology and geometry. The key includes exact ordered statement/operator/parent identities, excluding runtime values. Result dependencies invalidate layouts even if their parsed documents were already evicted.
- Result release invalidates that generation/result's entries; backend generation changes clear preparation. Query replacement and document close clear their scope. A document's content-change subscription remains until close, so edits in XML or while hidden also invalidate preparation. Late replies cannot repopulate invalidated caches.
- Pixi labels keep sprites by statement/operator identity and label role. Only newly visible or changed labels need text assignment. Surplus sprites are destroyed beyond 128 reusable spares, and the resulting idle Pixi textures are released; fitted text is capped at 2,048 entries. Pixi's managed text metrics already use a 1,000-entry LRU.

The layout worker uses an iterative ordered tree pass with disjoint subtree intervals, in O(operators + edges). It preserves SQL Server child order, supports multiple roots, and rejects duplicate identities, missing parents and cycles rather than inventing edges. It retains the existing consuming-parent arrow direction and orthogonal routing. The safety timeout and outline/XML fallback remain. The layout favors predictable scaling and sibling order; it does not try to minimize the total vertical extent of irregular trees.

Measurements on Windows x64, Intel Core Ultra 9 285K (24 logical CPUs), Node 24.14.0:

| Workload | Before | After |
| --- | --- | --- |
| 1,000 operators, one root with 999 inputs | Old ELK configuration still running at 152 s; stopped | Covered by the larger 2,000-operator measurement below |
| 1,000 operators, ordered four-way tree | Old ELK configuration: 60,213 ms, one cold run during concurrent checks | Covered by the larger 10,000-operator measurement below |
| 2,000 operators, one root with 1,999 inputs | Not run here; #161 reported exceeding the viewer timeout | 2.8–4.1 ms p95, 30 warm runs |
| 10,000 operators, ordered four-way tree | Not completed for this comparison | 9.9–12 ms p95, 30 warm runs |
| Exact cached layout lookup, 10,000 operators | Layout repeated on show | 0.92–1.08 ms p95, 100 lookups |

These are local measurements, not cross-machine guarantees. `tests/bench/plans.bench.ts` records the new metrics through the existing harness; `tests/bench/floors.json` and `docs/ipc.md` define their targets and conservative CI floors. Run `npm run bench`, then `node scripts/check-bench.mjs --enforce` with the other benchmark harness outputs available.

Regression checks cover hidden preparation, repeated mount/append reuse, shared cancellation, releases and generations, edits and late responses, independent budgets, cached GPU retry, live counter updates, stable label identity and destruction, 10,000-node wide/balanced/deep trees, forests, child ordering, graph rejection and non-overlap. Electron checks use normal output tabs and Graph/XML, preserve camera and selection, and count real parser calls. The existing editor and popout suites exercise split/floating/docked editors and canvas adoption. The live SQL suite additionally opens a 2,000-operator Showplan file through File > Open and exercises the real parser, Pixi, panning and Graph/XML.

Validation results are recorded in the pull request. SQL scratch/permission-matrix checks require the repository's explicit scratch opt-in; Entra checks require a tenant. GPU initialization/context failure continues to offer the outline and XML source. GPU contexts are recreated when a hidden viewer is shown, while expensive preparation is reused.

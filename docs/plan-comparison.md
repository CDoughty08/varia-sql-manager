# Execution plan comparison

Open **Window › Execution Plan › Plan history › Compare plans**. Choose a left and right retained snapshot or open
`.sqlplan` document, then **Compare selected plans**. **Open saved plan…** uses the normal file loader; its document
becomes another input choice. Two copies of the same input are allowed. Comparison is confined to this one pane per
workbench window. Closing it releases its inputs, workers, layouts, view state and canvases. It is not persisted.

Comparison freezes both XML strings at the moment Compare is pressed. For a document this includes its current
unsaved edits, name/path and model revision. Subsequent edits, saves, renaming, source closure, history removal or
eviction never rewrite an active comparison. Compare again to use the latest document contents. A document still
being filled cannot be acquired. **Swap plans** reverses the frozen inputs, including delta direction. **Open frozen
XML** opens an independent document containing exactly that side's comparison input.

Each side retains its original source/statement/operator identities. Retained inputs preserve capture type (Actual,
Estimated, or SQL-returned with unspecified type), isolated/query-session estimation mode, batch/repetition, execution
outcome, source context and independent partial-execution/incomplete/truncated flags. Saved XML has no such retained
capture metadata; capture type, estimation mode and execution outcome are explicitly unavailable. Runtime fields do
not establish capture type or successful completion. Parser omission notices are shown separately in each view.

## Pairing and inspection

Statements pair by unique exact trimmed statement text and type, followed by a unique query hash and type. SQL text
is not case folded or whitespace normalized: literals can be significant. Repeated statements are ambiguous; neither
StatementId nor occurrence order establishes a counterpart. Optimizer hashes are matching hints, not proof of
equivalent results. Materially different statements without either identity remain separate.

Within a paired statement, operators pair using unique physical/logical operation, object and normalized predicates,
then unique physical/logical operation and object, then unique logical operation and object (allowing changed physical
operations). Uniqueness is checked against the whole scope rather than created by earlier removals. Paired parents
can disambiguate unique operators in different branches. Repeated identical siblings stay ambiguous. NodeId, array
position, cost and runtime counters never decide operator identity. Matching is deterministic, conservative and does
not claim semantic equivalence. It can deliberately leave plausible counterparts unpaired.

The statement selector lists paired, ambiguous and side-only entries. The **Pairing list** shows up to 50 operator
entries per page, with explicit reasons and side-only/ambiguous labels. The virtual outlines mark those entries and
paired structural/property changes. A structural change means a different paired parent or sibling position. A
property change includes raw property or structured predicate/output/warning/spill differences. An unpaired parent
makes the relationship unavailable rather than claiming a structural move. **Differences** shows
the selected operator's estimates, counters, properties, diagnostic details, and expandable statement parameters,
grants and warnings. Changed/availability-different rows have both text and a background highlight. Each viewer's
normal Properties inspector remains available for original details.

**Link selection, zoom and pan** is on initially. Selecting an operator selects only its conservative counterpart;
an unpaired selection clears the other selection. Selecting a statement pair directs both outlines to those
statements; an absent counterpart is labeled. Zoom and pan share world camera coordinates across the two canvases.
Different topologies need not place paired nodes at the same coordinates. Disable the checkbox for independent
selection and cameras; the differences inspector still follows the last inspected pair. The graphs retain the
existing canvas's fit, keyboard/outline navigation, search, ranking, warnings and GPU fallback.

## Units and availability

- Every numeric delta is **right minus left**. Percentage is `(right − left) / left × 100`. Both measured zeros give
  zero and 0%; nonzero versus a zero baseline has no finite percentage and says **zero baseline**. Missing, invalid,
  negative or non-finite values stay unavailable. Overflowed percentages are unavailable.
- Actual rows, CPU milliseconds and executions use the normalized sums across all runtime thread entries. Counters
  already cover each entry's executions; they are never multiplied again. Parallel worker execution totals are not
  statement execution counts. Elapsed milliseconds use the maximum cumulative thread time, not query wall time.
  Times can include child work and overlap; comparison neither sums operators nor reports exclusive query time.
- Estimated rows are per optimizer execution; estimated total rows multiply by available estimated executions
  (`1 + EstimateRebinds + EstimateRewinds`). Actual worker counts never multiply these estimates. Costs use optimizer
  cost units, not milliseconds. Different GO repetitions remain separate inputs; no per-worker/per-run normalization
  or statistical significance is inferred. Partial captures remain partial even when a numeric delta is available.
- Parameters retain separate compiled/runtime values. Missing is unavailable; a reported empty string remains a
  measured empty value. Known memory amounts use KiB; GrantWaitTime uses milliseconds. Unknown grant and warning/spill
  attributes keep original names and values. Repeated thread IDs remain separate source-order entries, not guessed
  worker pairings. Truncated detail lists never replace the normalized aggregate counters.
- Old normalized plans without optional diagnostics remain usable. Unavailable or omitted lists do not become
  zero/empty metrics. An empty retained list says None reported, subject to that input's omission notices. Inspect
  frozen XML for the complete source.

## Budgets and lifecycle

Each input has the existing 8,388,608-character XML, 512-statement and 10,000-operator limits. There are exactly two
frozen XML strings (at most 32 MiB of UTF-16 XML, plus their bounded metadata); retained strings are shared with history
while present there. Preparation uses the existing window-owned parsed/layout caches and their independent budgets,
producer cap and cancellation semantics. Comparison scopes are removed on input replacement, hide, error or close;
late unary parse replies cannot repopulate them. Already-sent backend parses cannot be cancelled, remain counted
against the existing 64-producer cap until settled, and are never retried automatically.

Matching runs in a terminable worker, using indexed equality and paired-parent queues. Work and output are linear
in the bounded source data; no edit-distance matrix or ambiguous-candidate cross product is constructed. At most
20,000 operator entries can be returned across two completely unpaired inputs. The worker returns IDs and flags,
not duplicate normalized plan objects, and terminates on completion. Text cells display at most 4,096 characters
with an explicit shortening notice, while equality uses the full retained value; frozen XML remains available.
There is a 35-second overall preparation
deadline. Changing inputs/swapping/closing aborts consumers, terminates the old matching worker and layout workers,
and prevents stale results from restoring UI. Each Pixi viewer retains the existing visibility gating and bounded
label pools; the pairing list and difference inspector never render all operators as DOM rows.

## Validation

`tests/plan-comparison.test.ts` covers distinct/reordered/repeated statements, physical and structural changes,
ambiguous self joins, paired-parent disambiguation, 10,000-operator inputs, zeros/missing/overflow, units, repeated
execution scopes, parameter availability, safe text rendering and immutable document/retained provenance.
`tests/plan-comparison-ui.test.ts` covers linking, independent cameras, swaps, input changes and close while parsing
or matching is pending, including ignored late responses and scope release.

Run `npm run check`, then `npm run test:retained-plans` with `VARIA_TEST_SQL_SERVER=localhost` for its additional SQL
Server lane using integrated authentication. This existing isolated-profile Electron suite also opens frozen/saved
inputs through normal UI, exercises actual/estimated and cancelled captures, linked selection/zoom, independent
cameras, swap and close. Existing live/estimated viewer smoke suites remain regression checks. This feature does
not change backend capture or implement live-sample comparison, automatic semantic equivalence, manual pairing,
per-worker identity matching or statistical regression analysis.

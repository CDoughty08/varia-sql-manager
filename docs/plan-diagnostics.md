# Execution-plan diagnostics

Open a captured Actual, Live or Estimated plan in the output pane, or open a saved `.sqlplan` file. Select an operator
in the canvas or outline to inspect its properties. Hover shows a compact summary; the properties pane contains seek
ranges and residual predicates, output columns, available compiled/runtime parameters, memory grants, warning
attributes, missing-index column usage, spill records, estimated execution mode, parallelism and per-thread runtime.
The XML source remains unchanged and available from the plan document.

The outline's ranking selector ranks available CPU, elapsed time or row-estimate discrepancy in descending order.
Unreported values are excluded, measured zeros remain, and ties preserve plan order. Search and warning filters keep
working with rankings. Without a search/filter, rankings apply to the selected statement.

## Counter scopes and availability

- Rows, CPU milliseconds and executions sum every `RunTimeCountersPerThread` entry. These counters already cover that
  entry's executions: they are never multiplied by `ActualExecutions`. Repeated thread IDs remain separate entries.
  Parallel worker execution counts are not statement execution counts. Coordinator thread 0 remains visible.
- Elapsed milliseconds are the maximum of the entries' cumulative `ActualElapsedms` values. This is not query wall
  time. Operator times can include child work and overlap; neither CPU nor elapsed operator rankings are additive
  query totals or exclusive self time.
- An absent, negative, non-finite or invalid counter makes that aggregate unavailable if it is absent/invalid on any
  entry. A valid zero is displayed as zero. No runtime entries means no measured aggregate. Individual available
  counters remain inspectable even when the combined value is unavailable.
- Estimated rows are per execution. Estimated executions are `1 + EstimateRebinds + EstimateRewinds`, only when both
  attributes are available and valid. Estimated total rows multiply those two estimates, without multiplying for
  actual worker executions. Discrepancy compares actual total rows with estimated total rows: larger divided by
  smaller, marked as underestimate/overestimate. Both zero gives a match (1×); exactly one zero gives ∞×. Missing
  estimates or runtime rows make the comparison unavailable. Live totals remain partial.
- Costs, estimated rows/executions, estimated execution mode and missing-index impact are optimizer estimates in
  every plan kind. Missing-index suggestions preserve EQUALITY, INEQUALITY and INCLUDE groups; they are not actions.
- Parameters preserve compiled and runtime values separately. An absent runtime value is unavailable, not the
  compiled value. MemoryGrantInfo retains its attribute names: memory amounts are KiB and GrantWaitTime is milliseconds.
  Warning/spill attributes keep SQL Server's original names and units, including newer unknown attributes.

## Bounded model and live updates

The normalized model adds optional `diagnostics` objects on statements and operators. Older normalized replies and
saved XML lacking new fields stay usable. The parser uses the Showplan namespace and a streaming, operator-scoped
collector, without schema validation or version gates. Unknown operators and their existing raw properties survive.
Stable source, statement and operator IDs, hierarchy and live-to-actual matching are unchanged.

Existing XML, depth, operator, statement, property, text and reply caps remain unchanged. Structured lists hold at most
64 items, thread details at most 128 entries per operator, and all structured list entries share a 16,384-entry document
budget. Diagnostic strings use the existing 1 Mi-character text budget, with per-field caps. Omission produces a notice;
runtime aggregates still process every entry after detail truncation. The original XML is the complete fallback.
Legacy raw fields take text-budget priority so adding details cannot alter identity-bearing scalar properties.
Diagnostic text is staged under a separate bounded 1 Mi-character allowance, then trimmed to the unused portion of
the existing output text budget. A parameter value omitted entirely by that budget is unavailable, not an empty value.
If the detailed payload would exceed the existing reply cap, the optional diagnostic objects are omitted with a notice
before rejecting a graph that fits without them. Legacy operator fields, counters and identities take priority.

Live sampling retains the existing bounded topology/counter protocol and does not send per-thread diagnostic objects
or spill/grant details, which would become stale on subsequent counter-only samples. Live CPU/elapsed rankings use
current aggregate samples; detailed diagnostics and row comparisons become available from captured actual XML.
Completed captures replace transient nodes using the existing identities.

The model follows Microsoft's [Showplan schemas](https://schemas.microsoft.com/sqlserver/2004/07/showplan/) and
[per-operator runtime counters](https://support.microsoft.com/en-us/servicing/sql/sql-server-2014/cumulative-update/kb3170113-3170113-update-to-expose-per-operator-query-execution-statistics-in-showplan-xml-and-exten).

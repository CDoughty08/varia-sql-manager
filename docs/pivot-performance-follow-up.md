# Pivot performance investigation follow up

Status: not started. This investigation is separate from the [Grouped views implementation](grouped-results-implementation-plan.md), with one dependency: that plan's PR 17 rebuilds a Pivot automatically when its Table's filters change, below a source-row threshold that must come from this investigation's measurements. The rest of Grouped views (navigation, ownership, transformation eligibility) does not depend on it.

The reported problem is severe slowdown while using Pivot. Establish a reproducible case and separate backend work, result delivery, and UI work before choosing an optimization. Avoid attributing the problem to nested transformations or the vertical stack without measurements.

## Reproduction and baseline

Record the app revision, Release build configuration, OS, hardware, runtime versions, query/result shape, captured pivot recipe, source filter/sort, profile and Row size state, result budget, and whether the result was incomplete or truncated. Use synthetic or explicitly authorized data; keep rows and values out of logs and published traces.

Start with the screenshot's shape: two original results with about 20,463 rows and one `int` column, many repeated values, NULLs, and a Count grouped by that column. Capture its full result distribution when reproducing locally. Compare with a cold build, repeated builds, and a single-source run. The screenshot alone does not establish the timing or the cause.

Add controlled cases that vary one factor at a time:

| Dimension | Cases |
| --- | --- |
| Row volume | Small baseline, reported-size case, larger cases within existing budgets |
| Group cardinality | Few repeated groups, many groups, near the supported group/cell limits |
| Shape | Narrow and wide source; one and multiple row groups; column group absent/present; one and multiple values |
| Values | Integers, exact decimals, floating point, text and collations, NULLs, long stored prefixes |
| Recipe | Count, Distinct Count, Sum, Average, Min and Max where supported |
| Source view | Unfiltered input, heavily filtered input, sorted input, pending sort/filter settlement |
| UI state | Profile/Row size off, then enabled individually; grid visible, then inactive; derived replacement and repeated close/rebuild |
| Resource pressure | Adequate budget, near-budget refusal, cancellation, source closure and backend loss |

Use the same fixtures and settings when comparing the pre-grouped and grouped UI. Keep backend-only and end-to-end results separate.

## Measure each stage

Capture request-to-completion time, request-to-first-paint time, CPU, managed allocations, peak charged working/result memory, retained memory after close, GC activity, cancellation latency, and renderer responsiveness. Report cold and warm samples and median/tail distributions rather than a single favorable run.

Separate these stages:

1. Command dispatch, waiting for source views, request queuing, and result-port scheduling.
2. Backend working-memory reservation and source/page access.
3. Key construction, collation normalization, sorting/grouping, and aggregate computation.
4. Output columns/pages, sealing, and the result descriptor response.
5. Main/worker delivery, window decoding, grid mount, column measurement, and first paint.
6. Profile/highlight/search work triggered by the new result, plus close/replacement cleanup.

Begin at `SqlService.PivotAsync`, `Results/ResultPivot.cs`, `ResultViews.cs`, `ResultDiff.cs`'s shared row-access helpers, `PivotService.ts`, `ResultClient.ts`, and the grid benchmark harness. Add bounded timing/count instrumentation only where it distinguishes these stages. Do not log SQL text, names, values, or credentials.

## Questions to resolve

- Does backend grouping dominate, or does the delay occur before the request or after the answer?
- Are sort keys, page layouts, or text normalization recomputed more than needed for a recipe?
- How does requested working memory relate to the source rows actually visited? In particular, inspect the full-source versus filtered-view reservation path before treating it as the cause.
- Do multiple aggregates repeat scans or allocate per-cell temporary values?
- Is output column measurement or profiling more costly than the aggregation for narrow, low-cardinality pivots?
- Does a rebuild correctly release the superseded result and auxiliary views? Distinguish live leases and bounded caches from leaks.
- What is the peak budget during atomic replacement, and does refusal preserve the prior view?
- Does cancellation promptly stop expensive phases and release working memory? Do rejected or late responses leave any retained result?

These are investigation questions, not findings. Select a fix only after a reproducible measurement identifies the expensive or incorrect path.

## Deliverables and exit criteria

Produce a small reproducible fixture set, stage-by-stage baseline measurements, an explanation of the dominant cost, and a bounded change proposal with before/after results. Define any performance target from the measured baseline and intended interaction; do not invent a pass threshold in advance of measurement.

Keep optimization PRs separate from Grouped views. Add a regression benchmark for the identified bottleneck and correctness checks for affected numeric, collation, NULL, grouping, truncation, and cancellation behavior. Preserve existing memory accounting and refusal rules; no disk spill, silent pivot truncation, renderer-side aggregation, or raised limits as a substitute for a fix.

Use the repository's benchmark tools and CI guidance. New offline timing checks must pass the documented stress procedure, and any new smoke/live workload needs its measured CI cost recorded. Retain benchmark results with environment and revision information so later changes can be compared meaningfully.

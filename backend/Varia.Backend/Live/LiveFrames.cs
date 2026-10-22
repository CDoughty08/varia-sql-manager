namespace Varia.Backend.Live;

// The EVENT bodies and answers of live.subscribe and live.update (src/shared/live/schema.ts is their schema; main
// validates every frame against it). Null members are left out of the frame.

internal sealed record LiveOpenedProbe(string Probe, int IntervalMs, int MinIntervalMs, int MaxIntervalMs, string State, string? Reason = null, string? Note = null);
internal sealed record LiveOpenedEvent(string Type, long Seq, string Source, int? Band, int? Spid, string? Isolation, IReadOnlyList<LiveOpenedProbe> Probes);
internal sealed record LiveDiff(int Added, int Removed, int Changed);
internal sealed record LiveTracked(int Seq, int[] Rows);
internal sealed record LiveFacetValue(string Text, int Count);
/// <summary>A facet column's distinct values, most frequent first; More (true or null) when some were left out.</summary>
internal sealed record LiveFacet(string Column, IReadOnlyList<LiveFacetValue> Values, bool? More = null);
/// <summary>Departed: rows that left the source and stay this one revision (tracked, in a table that keeps them); Facets:
/// the facet columns whose values changed.</summary>
internal sealed record LiveSnapshotSample(int Table, ResultDescriptor Descriptor, long Revision, uint[]? Retired = null, LiveDiff? Diff = null, LiveTracked? Tracked = null,
    int[]? Departed = null, IReadOnlyList<LiveFacet>? Facets = null);
/// <summary>Restarted (true or null): the table started again, and Retired names every segment it had.</summary>
internal sealed record LiveAppendSample(int Table, ResultDescriptor Descriptor, int Segment, uint? RolledFrom = null, uint[]? Retired = null, bool? Restarted = null);
/// <summary>Value is a whole number or a string of at most 128 characters.</summary>
internal sealed record LiveStatus(string Id, object Value);
internal sealed record LiveSample(string Probe, int CostMs, int EffectiveIntervalMs, long? ElapsedMs = null, string? Gap = null, int? Skipped = null, double?[]? Metrics = null,
    IReadOnlyList<LiveSnapshotSample>? Tables = null, IReadOnlyList<LiveAppendSample>? Append = null, IReadOnlyList<LiveStatus>? Status = null);
/// <summary>A probe's failure as a value: Message is a complete sentence, never SQL text, names or values.</summary>
internal sealed record LiveProbeError(string Probe, string Code, string Message, int? Number, int RetryInMs, bool Terminal, int[]? Tables = null, int[]? Series = null);
internal sealed record LiveTickEvent(string Type, long Seq, long SampledAt, int? Spid, string? Resume, IReadOnlyList<LiveSample> Samples, IReadOnlyList<LiveProbeError>? Errors);
/// <summary>The final RESPONSE: Ended is cancelled, disconnected, sourceEnded (Kept stays readable), failed (Code and
/// Message) or shutdown.</summary>
internal sealed record LiveEnd(string Ended, string? Code, string? Message, uint[]? Kept, string? Resume, long Ticks, long ElapsedMs);
internal sealed record LiveProbeApplied(string Probe, int IntervalMs, int EffectiveIntervalMs, bool Paused);
internal sealed record LiveUpdateResult(bool Applied, IReadOnlyList<LiveProbeApplied> Probes);

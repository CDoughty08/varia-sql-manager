using System.Globalization;

namespace Varia.Backend.BigQuery;

/// <summary>
/// How Varia writes BigQuery's byte figures and their on-demand price (docs/bigquery.md, Cost): binary units, as Google
/// bills (KiB, MiB, GiB, TiB, PiB, two decimals), and dollars at the US on-demand rate per TiB, "&lt; $0.01" below a cent.
/// The price is an estimate: projects with capacity (reservations) do not pay per byte. src/shared/bigquery/cost.ts writes
/// the same text, and tests/fixtures/bigquery/cost.json pins both.
/// </summary>
internal static class BigQueryCost
{
    /// <summary>The US multi-region's on-demand query price, in dollars per TiB (Google's pricing page).</summary>
    public const decimal DollarsPerTiB = 6.25m;
    private const decimal TiB = 1L << 40;
    private static readonly string[] Units = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

    /// <summary>"0 B", "1023 B", "1.00 KiB", "1.24 GiB": bytes below a KiB whole, larger figures in the largest binary unit
    /// that keeps the number at least 1, to two decimals.</summary>
    public static string Bytes(long bytes)
    {
        if (bytes < 1024) return Math.Max(0, bytes).ToString(CultureInfo.InvariantCulture) + " B";
        var value = (decimal)bytes;
        var unit = -1;
        while (value >= 1024 && unit < Units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        // Rounding can carry a figure to 1024.00 of a unit; it is then 1.00 of the next.
        var rounded = Math.Round(value, 2, MidpointRounding.AwayFromZero);
        if (rounded >= 1024 && unit < Units.Length - 1)
        {
            rounded = Math.Round(value / 1024, 2, MidpointRounding.AwayFromZero);
            unit++;
        }
        return rounded.ToString("0.00", CultureInfo.InvariantCulture) + " " + Units[unit];
    }

    /// <summary>The on-demand price of a byte count: "$0.00" for none, "&lt; $0.01" below a cent, else dollars to the cent
    /// with thousands separators ("$8.75", "$1,234.50").</summary>
    public static string Dollars(long bytes)
    {
        if (bytes <= 0) return "$0.00";
        var dollars = bytes / TiB * DollarsPerTiB;
        if (dollars < 0.01m) return "< $0.01";
        return "$" + Math.Round(dollars, 2, MidpointRounding.AwayFromZero).ToString("#,##0.00", CultureInfo.InvariantCulture);
    }

    /// <summary>"1.24 GiB (&lt; $0.01)": a figure with its on-demand price beside it.</summary>
    public static string Priced(long bytes) => Bytes(bytes) + " (" + Dollars(bytes) + ")";

    /// <summary>Slot time as BigQuery reports it, in milliseconds: "250 ms", "1.2 s", "3 min 4 s", "2 h 5 min".</summary>
    public static string SlotTime(long milliseconds)
    {
        if (milliseconds < 1000) return Math.Max(0, milliseconds).ToString(CultureInfo.InvariantCulture) + " ms";
        if (milliseconds < 60_000) return (milliseconds / 1000m).ToString("0.0", CultureInfo.InvariantCulture) + " s";
        var seconds = milliseconds / 1000;
        if (seconds < 3600) return (seconds / 60).ToString(CultureInfo.InvariantCulture) + " min " + (seconds % 60).ToString(CultureInfo.InvariantCulture) + " s";
        return (seconds / 3600).ToString(CultureInfo.InvariantCulture) + " h " + (seconds % 3600 / 60).ToString(CultureInfo.InvariantCulture) + " min";
    }

    /// <summary>The Messages line every finished job gets: bytes processed and billed with their price, slot time and cache
    /// hit, each only when BigQuery reported it, and that the price is an on-demand estimate. Null when it reported none of
    /// them (the emulator).</summary>
    public static string? Summary(BigQueryJobSummary job)
    {
        var parts = new List<string>();
        if (job.BytesProcessed is { } processed) parts.Add("Bytes processed: " + Priced(processed));
        if (job.BytesBilled is { } billed) parts.Add("Bytes billed: " + Priced(billed));
        if (job.SlotMs is { } slots) parts.Add("Slot time: " + SlotTime(slots));
        if (job.CacheHit is { } hit) parts.Add("Cache hit: " + (hit ? "yes" : "no"));
        if (parts.Count == 0) return null;
        var priced = job.BytesProcessed is not null || job.BytesBilled is not null;
        return string.Join(" · ", parts) + (priced ? " · Prices are on-demand estimates at $" + DollarsPerTiB.ToString("0.00", CultureInfo.InvariantCulture) + " per TiB." : "");
    }
}

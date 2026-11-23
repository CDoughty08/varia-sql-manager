using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Result stores for offline checks that host a <see cref="SqlService"/> (docs/testing.md): the budget the backend
/// would size for this machine, without the memory-load probe. <see cref="ResultStore.FromSystem"/> refuses every row once
/// the machine passes its 90 % high-load threshold, which parallel lanes and other sessions reach on a developer machine,
/// and then a check reads a truncated or empty result as its own failure.</summary>
internal static class CheckStores
{
    public static ResultStore Unprobed()
    {
        var global = ResultStore.GlobalBytesFor(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes);
        return new ResultStore(global, global / 2);
    }
}

using System.Collections;
using System.Diagnostics;
using Varia.Backend;

namespace Varia.Backend.Tests;

/// <summary>A result's columns that run an action once, the first time they are read after it is set: what happens to a
/// query while one of its results is compared, pivoted or transposed. With <see cref="Within"/>, only a read made from
/// that type's code counts, so the action lands inside the work and not in the request's checks before it.</summary>
internal sealed class Tripwire(ResultColumn[] columns) : IReadOnlyList<ResultColumn>
{
    public Action? OnRead { get; set; }
    /// <summary>The type whose frames must be on the stack ("ResultPivoter"); null for any read.</summary>
    public string? Within { get; init; }

    private ResultColumn[] Read()
    {
        if (OnRead is not { } action || (Within is not null && !new StackTrace().ToString().Contains(Within + ".", StringComparison.Ordinal))) return columns;
        OnRead = null;
        action();
        return columns;
    }

    public ResultColumn this[int index] => Read()[index];
    public int Count => Read().Length;
    public IEnumerator<ResultColumn> GetEnumerator() => ((IEnumerable<ResultColumn>)Read()).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

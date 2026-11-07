namespace Varia.Backend.Tests;

/// <summary>
/// CI splits the live SQL Server suites across jobs, each with a server of its own: `--live-group k/n` runs only group k of n,
/// and no offline checks (Check (ubuntu) runs those). The groups are balanced by the time each suite took, as
/// scripts/smoke-shards.mjs balances the smoke suites.
/// </summary>
public static class LiveGroups
{
    /// <summary>The live job's matrix in .github/workflows/ci.yml (tests/ci-workflow.test.ts holds them equal).</summary>
    public const int CiGroups = 3;

    /// <summary>
    /// The most one group may take in CI, so a slow new suite fails the offline checks instead of quietly lengthening every
    /// run: speed it up, or raise <see cref="CiGroups"/> and the live job's matrix together.
    /// </summary>
    public const int BudgetSeconds = 360;

    /// <summary>
    /// Every live suite in the order Program.cs runs them, with the seconds it took in CI's Linux live job (the mean of PR
    /// #99's first two runs; each suite prints "Live suite name: n s"). Rough is fine, but a suite's time can swing by a
    /// minute between runs (Scripting took 151 s and 233 s), so a mean of runs beats one. A new suite needs an entry here,
    /// or the live run fails. LoginProperties, Securables, LoginKinds and CellLength have times from a local SQL Server 2025 run until
    /// CI times them.
    /// </summary>
    public static readonly (string Name, int Seconds)[] Suites =
    [
        ("Query", 9), ("Live", 0), ("LiveData", 17), ("LiveTableData", 13), ("ExplorerStatus", 13), ("Execution", 19), ("Transaction", 5),
        ("LiveResult", 62), ("ClientStatistics", 3), ("CellLength", 1), ("Explorer", 36), ("Scripting", 150), ("ScriptingInjection", 42), ("Action", 32), ("ServerFiles", 1), ("Seam", 24), ("DatabaseState", 16),
        ("RenameDatabase", 23), ("Detach", 25), ("ActionProgress", 4), ("Attach", 2), ("Restore", 28), ("Login", 11), ("LoginListing", 0), ("LoginAction", 3), ("LoginDelete", 2), ("Unlock", 3),
        ("LoginProperties", 5), ("Securables", 2), ("LoginKinds", 5), ("DatabaseProperties", 47),
        ("Designer", 8), ("NewDatabase", 1), ("Ssis", 111), ("Activity", 1), ("ActivitySource", 28), ("ActivityAction", 1), ("SsisCreate", 0),
        ("Entra", 0)
    ];

    /// <summary>Group <c>Index</c> of <c>Count</c>, or with <c>Suite</c> only that suite (a developer's `--live-suite name`).</summary>
    public sealed record Group(int Index, int Count, string? Suite = null);

    /// <summary>`--live-group k/n` as a group, `--live-suite name` as one suite, no arguments as null (every suite, after the
    /// offline checks).</summary>
    public static Group? Parse(string[] args)
    {
        if (args is ["--live-suite", var suite])
            return Suites.Any(item => item.Name == suite) ? new(1, 1, suite) : throw new ArgumentException("Unknown live suite " + suite + "; LiveGroups.Suites names them.");
        if (args is not ["--live-group", var value]) return null;
        var parts = value.Split('/');
        if (parts.Length == 2 && int.TryParse(parts[0], out var index) && int.TryParse(parts[1], out var count) && count >= 1 && index >= 1 && index <= count)
            return new(index, count);
        throw new ArgumentException("Usage: --live-group <group>/<count>, for example 1/2.");
    }

    /// <summary>Splits the suites into groups of similar time (longest first, each to the lightest group), each in run order.</summary>
    public static List<List<string>> Split(IReadOnlyList<(string Name, int Seconds)> suites, int count)
    {
        var totals = new int[count];
        var owner = new Dictionary<string, int>();
        foreach (var (suite, index) in suites.Select((suite, index) => (suite, index)).OrderByDescending(item => item.suite.Seconds).ThenBy(item => item.index))
        {
            var lightest = Array.IndexOf(totals, totals.Min());
            totals[lightest] += suite.Seconds;
            owner[suite.Name] = lightest;
        }
        return [.. Enumerable.Range(0, count).Select(group => suites.Where(suite => owner[suite.Name] == group).Select(suite => suite.Name).ToList())];
    }

    /// <summary>Whether this run runs the named suite; a suite with no entry in <see cref="Suites"/> fails the run.</summary>
    public static bool Runs(Group? group, string name)
    {
        if (!Suites.Any(suite => suite.Name == name)) throw new Exception("FAIL: the live suite " + name + " needs its seconds in LiveGroups.Suites.");
        if (group?.Suite is { } only) return name == only;
        return group is null || Split(Suites, group.Count)[group.Index - 1].Contains(name);
    }

    /// <summary>Whether the suites a run reached are exactly <see cref="Suites"/>, in order.</summary>
    public static bool Covers(IEnumerable<string> reached) => reached.SequenceEqual(Suites.Select(suite => suite.Name));
}

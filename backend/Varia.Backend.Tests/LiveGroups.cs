namespace Varia.Backend.Tests;

/// <summary>
/// CI splits the live SQL Server suites across jobs, each with a server of its own: `--live-group k/n` runs only group k of n,
/// and no offline checks (Check (ubuntu) runs those). The groups are balanced by the time each suite took, as
/// scripts/smoke-shards.mjs balances the smoke suites.
/// </summary>
public static class LiveGroups
{
    /// <summary>The live job's matrix in .github/workflows/ci.yml (tests/ci-workflow.test.ts holds them equal).</summary>
    public const int CiGroups = 2;

    /// <summary>
    /// The most one group may take in CI, so a slow new suite fails the offline checks instead of quietly lengthening every
    /// run: speed it up, or raise <see cref="CiGroups"/> and the live job's matrix together.
    /// </summary>
    public const int BudgetSeconds = 360;

    /// <summary>
    /// Every live suite in the order Program.cs runs them, with the seconds it took in CI's Linux live job (each prints
    /// "Live suite name: n s"; rough is fine). A new suite needs an entry here, or the live run fails.
    /// </summary>
    public static readonly (string Name, int Seconds)[] Suites =
    [
        ("Query", 20), ("Live", 5), ("LiveData", 10), ("LiveTableData", 5), ("ExplorerStatus", 5), ("Execution", 15), ("Transaction", 10),
        ("LiveResult", 50), ("Explorer", 40), ("Scripting", 170), ("Action", 40), ("ServerFiles", 10), ("Seam", 20), ("DatabaseState", 15),
        ("RenameDatabase", 15), ("Detach", 15), ("ActionProgress", 15), ("Attach", 15), ("Restore", 15), ("Login", 20), ("LoginListing", 6), ("DatabaseProperties", 40),
        ("Designer", 30), ("NewDatabase", 30), ("Ssis", 47), ("Activity", 5), ("ActivitySource", 25), ("ActivityAction", 3), ("SsisCreate", 1),
        ("Entra", 1)
    ];

    public sealed record Group(int Index, int Count);

    /// <summary>`--live-group k/n` as a group, no arguments as null (every suite, after the offline checks).</summary>
    public static Group? Parse(string[] args)
    {
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
        return group is null || Split(Suites, group.Count)[group.Index - 1].Contains(name);
    }

    /// <summary>Whether the suites a run reached are exactly <see cref="Suites"/>, in order.</summary>
    public static bool Covers(IEnumerable<string> reached) => reached.SequenceEqual(Suites.Select(suite => suite.Name));
}

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
    /// Every live suite in the order Program.cs runs them, with the seconds it took in CI's Linux live job (PR #723 green run
    /// 45451778872, 2026-11-24; each suite prints "Live suite name: n s"). A new suite needs an entry here, or the live run fails.
    /// </summary>
    public static readonly (string Name, int Seconds)[] Suites =
    [
        ("Query", 10), ("Live", 0), ("LiveData", 18), ("LiveTableData", 13), ("ExplorerStatus", 27), ("Execution", 42), ("ResultName", 1), ("EstimatedPlans", 3), ("Transaction", 5), ("MultiQuery", 4),
        ("LiveResult", 62), ("ClientStatistics", 1), ("CellLength", 0), ("Explorer", 45), ("Scripting", 198), ("ScriptingInjection", 44), ("Action", 33), ("ServerFiles", 1), ("Seam", 24), ("DatabaseState", 17),
        ("RenameDatabase", 23), ("Detach", 25), ("ActionProgress", 3), ("Attach", 2), ("Restore", 27), ("Login", 12), ("LoginListing", 0), ("LoginAction", 3), ("LoginDelete", 2), ("Unlock", 3),
        ("LoginProperties", 2), ("Securables", 3), ("LoginKinds", 1), ("DatabaseProperties", 43), ("TableProperties", 1),
        ("Designer", 10), ("NewDatabase", 1), ("Ssis", 51), ("Activity", 1), ("ActivitySource", 28), ("ActivityResources", 6), ("ActivityQuery", 0), ("ActivityAction", 0), ("SsisCreate", 0),
        ("Entra", 0), ("Agent", 31)
    ];

    /// <summary>
    /// Live suites no grouped or full run reaches, each run only when `--live-suite` names it: AgentService stops and starts the
    /// server's SQL Server Agent, which `backend:test`'s shared machine lock cannot keep other sessions' Agent checks off, so it runs
    /// through `npm run backend:test:agent-service` (the exclusive lock) and the Windows workflow (agent-service.yml).
    /// </summary>
    public static readonly (string Name, int Seconds)[] Excluded = [("AgentService", 40)];

    /// <summary>Group <c>Index</c> of <c>Count</c>, or with <c>Suite</c> only the suites it names, comma-separated (`--live-suite a,b`).</summary>
    public sealed record Group(int Index, int Count, string? Suite = null);

    /// <summary>`--live-group k/n` as a group, `--live-suite name[,name...]` as those suites (an excluded one included), no arguments as
    /// null (every suite in <see cref="Suites"/>, after the offline checks).</summary>
    public static Group? Parse(string[] args)
    {
        if (args is ["--live-suite", var suite])
            return suite.Split(',').All(name => Known(name)) ? new(1, 1, suite) : throw new ArgumentException("Unknown live suite in " + suite + "; LiveGroups.Suites and Excluded name them.");
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

    private static bool Known(string name) => Suites.Any(suite => suite.Name == name) || Excluded.Any(suite => suite.Name == name);

    /// <summary>Whether this run runs the named suite: one `--live-suite` names, or else one of its group, never an excluded one; a suite
    /// with no entry in <see cref="Suites"/> or <see cref="Excluded"/> fails the run.</summary>
    public static bool Runs(Group? group, string name)
    {
        if (!Known(name)) throw new Exception("FAIL: the live suite " + name + " needs its seconds in LiveGroups.Suites.");
        if (group?.Suite is { } only) return only.Split(',').Contains(name);
        if (Excluded.Any(suite => suite.Name == name)) return false;
        return group is null || Split(Suites, group.Count)[group.Index - 1].Contains(name);
    }

    /// <summary>Whether the suites a run reached are exactly <see cref="Suites"/>, in order (the excluded ones aside).</summary>
    public static bool Covers(IEnumerable<string> reached) => reached.Where(name => Excluded.All(suite => suite.Name != name)).SequenceEqual(Suites.Select(suite => suite.Name));
}

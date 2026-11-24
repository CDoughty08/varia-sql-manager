using System.Globalization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Activity;

/// <summary>A job step's session as its program_name names it (AG-16): the job's id and the step's id.</summary>
internal readonly record struct AgentJobRef(Guid JobId, int Step);

/// <summary>SQL Server Agent's program names, parsed with the catalogue's pattern (src/shared/activity/agent-program.ts parses
/// with the same one): <c>SQLAgent - TSQL JobStep (Job 0x&lt;job id&gt; : Step &lt;n&gt;)</c>, where the job id is the job_id's
/// 16 bytes as SQL Server stores a uniqueidentifier, which <see cref="Guid(byte[])"/> reads in the same order.</summary>
internal static class AgentPrograms
{
    /// <summary>sys.dm_exec_sessions.program_name is nvarchar(128).</summary>
    private const int ProgramChars = 128;

    /// <summary>The job step a program name names, or null for any other program, one of Agent's own threads, or a malformed name.</summary>
    public static AgentJobRef? Parse(string? program, ActivityCatalog catalog)
    {
        if (program is null || program.Length > ProgramChars || !program.StartsWith(catalog.AgentProgramPrefix, StringComparison.Ordinal)) return null;
        Match match;
        try { match = catalog.AgentStepPattern.Match(program); }
        catch (RegexMatchTimeoutException) { return null; }
        // .NET's $ also matches before a final newline, which JavaScript's does not: the match must be the whole name.
        if (!match.Success || match.Length != program.Length) return null;
        if (!int.TryParse(match.Groups["step"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var step) || step < 1) return null;
        return new(new Guid(Convert.FromHexString(match.Groups["job"].Value)), step);
    }

    /// <summary>The id as SQL Server shows a uniqueidentifier (upper case, hyphenated), as the renderer decodes it.</summary>
    public static string Id(Guid jobId) => jobId.ToString("D").ToUpperInvariant();

    /// <summary>The Agent Job column's words: "Nightly, step 2 (Load)", or "Job &lt;id&gt;, step 2" where msdb named no job to the
    /// login (agentJobText in the renderer says the same).</summary>
    public static string Text(AgentJobRef job, string? name, string? stepName)
    {
        var step = job.Step.ToString(CultureInfo.InvariantCulture);
        if (string.IsNullOrEmpty(name)) return "Job " + Id(job.JobId) + ", step " + step;
        return name + ", step " + step + (string.IsNullOrEmpty(stepName) ? "" : " (" + stepName + ")");
    }
}

/// <summary>The names of the Agent jobs and steps a monitor's sessions run (AG-16), read through <see cref="ActivitySql.AgentJobs"/>
/// and <see cref="ActivitySql.AgentSteps"/> and kept per monitor connection (one server, one login: msdb shows each login its own
/// jobs). A name, or msdb naming none, is kept agentJobNamesMs before it is asked again, so a renamed job shows its new name within
/// that and a running job costs one small read a minute; a read that failed for the moment waits as long. A read msdb refuses for
/// good (PERMISSION_DENIED: no msdb user, no Agent role, sysjobsteps below sysadmin) is not tried again on the connection, and the
/// rows show the decoded id and step without names. At most agentJobCache jobs and as many steps; past that, what is stale goes,
/// then everything. Not thread-safe: the sessions probe runs one sample at a time.</summary>
internal sealed class AgentJobNames(ActivityCatalog catalog, Func<long>? clock = null)
{
    private readonly record struct Entry(string? Value, long ReadAt);

    private readonly Func<long> now = clock ?? (() => Environment.TickCount64);
    private readonly Dictionary<Guid, Entry> jobs = [];
    private readonly Dictionary<AgentJobRef, Entry> steps = [];

    /// <summary>msdb refused the names (or the step names) for good on this connection.</summary>
    public bool NamesRefused { get; private set; }
    public bool StepsRefused { get; private set; }

    private int Slots => (int)Math.Min(catalog.Limit("agentJobSlots"), ActivitySql.AgentJobSlots);
    private long KeepMs => catalog.Limit("agentJobNamesMs");

    /// <summary>A new connection (perhaps another server after a failover, or a login now granted msdb) asks again.</summary>
    public void Reset()
    {
        jobs.Clear();
        steps.Clear();
        NamesRefused = false;
        StepsRefused = false;
    }

    /// <summary>The job ids of <paramref name="running"/> whose names are not kept (or kept too long), at most one read's slots.</summary>
    public IReadOnlyList<Guid> WantedJobs(IEnumerable<AgentJobRef> running)
    {
        if (NamesRefused) return [];
        var time = now();
        return [.. running.Select(job => job.JobId).Distinct().Where(id => !Fresh(jobs, id, time)).Take(Slots)];
    }

    /// <summary>The steps of <paramref name="running"/> whose names are not kept, of jobs msdb named: a job it did not name has no step names to read.</summary>
    public IReadOnlyList<AgentJobRef> WantedSteps(IEnumerable<AgentJobRef> running)
    {
        if (NamesRefused || StepsRefused) return [];
        var time = now();
        return [.. running.Distinct().Where(job => jobs.TryGetValue(job.JobId, out var named) && named.Value is not null && !Fresh(steps, job, time)).Take(Slots)];
    }

    /// <summary>What a names read returned for the ids it asked for: a missing id is a job msdb does not show the login.</summary>
    public void AddJobs(IReadOnlyList<Guid> asked, ActivityResult result)
    {
        var found = new Dictionary<Guid, string?>();
        foreach (var row in result.Rows) if (result.Get(row, "job_id") is Guid id) found[id] = result.Text(row, "name");
        var time = now();
        foreach (var id in asked) jobs[id] = new(found.GetValueOrDefault(id), time);
        Trim(jobs, time);
    }

    public void AddSteps(IReadOnlyList<AgentJobRef> asked, ActivityResult result)
    {
        var found = new Dictionary<AgentJobRef, string?>();
        foreach (var row in result.Rows)
            if (result.Get(row, "job_id") is Guid id && result.Int(row, "step_id") is { } step) found[new(id, step)] = result.Text(row, "step_name");
        var time = now();
        foreach (var job in asked) steps[job] = new(found.GetValueOrDefault(job), time);
        Trim(steps, time);
    }

    /// <summary>A read failed for the moment (a lock wait, the budget): the names it asked for wait out agentJobNamesMs, keeping
    /// what was known, so a busy msdb is not asked every sample.</summary>
    public void MissedJobs(IReadOnlyList<Guid> asked)
    {
        var time = now();
        foreach (var id in asked) jobs[id] = new(jobs.GetValueOrDefault(id).Value, time);
        Trim(jobs, time);
    }

    public void MissedSteps(IReadOnlyList<AgentJobRef> asked)
    {
        var time = now();
        foreach (var job in asked) steps[job] = new(steps.GetValueOrDefault(job).Value, time);
        Trim(steps, time);
    }

    public void RefuseNames() => NamesRefused = true;
    public void RefuseSteps() => StepsRefused = true;

    /// <summary>The row's Agent Job words and the job's name (null when msdb named none), for a session's program name; null for a
    /// session that runs no job step.</summary>
    public (string Text, string? Name)? Resolve(string? program)
    {
        if (AgentPrograms.Parse(program, catalog) is not { } job) return null;
        var name = jobs.TryGetValue(job.JobId, out var named) ? named.Value : null;
        var stepName = name is not null && steps.TryGetValue(job, out var step) ? step.Value : null;
        return (AgentPrograms.Text(job, name, stepName), name);
    }

    private bool Fresh<TKey>(Dictionary<TKey, Entry> entries, TKey key, long time) where TKey : notnull =>
        entries.TryGetValue(key, out var entry) && time - entry.ReadAt < KeepMs;

    private void Trim<TKey>(Dictionary<TKey, Entry> entries, long time) where TKey : notnull
    {
        var cap = catalog.Limit("agentJobCache");
        if (entries.Count <= cap) return;
        foreach (var key in entries.Where(entry => time - entry.Value.ReadAt >= KeepMs).Select(entry => entry.Key).ToList()) entries.Remove(key);
        if (entries.Count > cap) entries.Clear();
    }
}

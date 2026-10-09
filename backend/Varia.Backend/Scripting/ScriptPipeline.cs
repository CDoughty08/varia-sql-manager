using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Scripting;

/// <summary>Where a script goes, batch by batch. Append returns false once the sink's cap is reached (TOO_LARGE).</summary>
internal interface IScriptSink
{
    /// <summary>Characters the sink still accepts.</summary>
    long Remaining { get; }
    bool Append(string text);
    void Progress(int done, int total);
}

/// <summary>Collects the whole script in memory for scripting.script, at most <paramref name="max"/> characters.</summary>
internal sealed class StringScriptSink(long max) : IScriptSink
{
    private readonly StringBuilder text = new();

    public long Remaining => max - text.Length;
    public int Done { get; private set; }

    public bool Append(string value)
    {
        if (value.Length > Remaining) return false;
        text.Append(value);
        return true;
    }

    public void Progress(int done, int total) => Done = done;

    public override string ToString() => text.ToString();
}

/// <summary>What one job scripts: resolved targets, one verb, the request's options. Prefetch is for many objects (the
/// Generate Scripts wizard); for one object it would read every object of its type in the database.</summary>
internal sealed record ScriptJob(string ConnectionId, IReadOnlyList<ResolvedTarget> Targets, ScriptVerbRow Verb, ScriptingOptionsDto Options, bool Prefetch = false);

/// <summary>The open connection a job runs on, the server it reached, and whether that is a cloud edition (one database
/// per connection, so no USE).</summary>
internal sealed record ScriptSession(SqlConnection Connection, ServerProfile Profile, bool Cloud);

/// <summary>Scripts each target in order into a sink: SMO's batches for DDL verbs, framed as SSMS frames them. Runs on a
/// dedicated thread (SMO blocks), checking the token between batches; the tracker cancels the statement in flight.</summary>
internal static class ScriptPipeline
{
    /// <returns>The warnings the job produced (header guard, version mapping).</returns>
    public static IReadOnlyList<string> Run(ScriptJob job, SmoScriptRunner runner, IScriptSink sink, CancellationToken token)
    {
        var warnings = new List<string>();
        for (var index = 0; index < job.Targets.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            var target = job.Targets[index];
            if (job.Verb.Class != VerbClass.Ddl) throw new TemplateUnavailableException();
            var text = runner.Script(target, job.Verb.Verb, job.Options, sink.Remaining, warnings);
            if (!sink.Append(text)) throw new ScriptTooLargeException();
            sink.Progress(index + 1, job.Targets.Count);
        }
        return warnings;
    }
}

/// <summary>SELECT, INSERT, UPDATE, DELETE and EXECUTE come from SSMS's templates, which this build does not have yet.</summary>
internal sealed class TemplateUnavailableException() : Exception("Templates are not available.");

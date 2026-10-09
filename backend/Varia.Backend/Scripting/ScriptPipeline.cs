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

/// <summary>What one job scripts: resolved targets, one verb, the request's options. Prefetch is for the Generate Scripts
/// wizard's many objects; one object prefetches only its own children (SmoScriptRunner.PrefetchKinds).</summary>
internal sealed record ScriptJob(string ConnectionId, IReadOnlyList<ResolvedTarget> Targets, ScriptVerbRow Verb, ScriptingOptionsDto Options, bool Prefetch = false);

/// <summary>The open connection a job runs on, the server it reached, and whether that is a cloud edition (one database
/// per connection, so no USE).</summary>
internal sealed record ScriptSession(SqlConnection Connection, ServerProfile Profile, bool Cloud);

/// <summary>Scripts each target in order into a sink, framed as SSMS frames scripts: SMO's batches for DDL verbs, which
/// run on a dedicated thread (SMO blocks) with the token checked between batches and the tracker cancelling the
/// statement in flight; for the other verbs, the template over the preflight's rows, after a USE batch whenever the
/// database changes.</summary>
internal static class ScriptPipeline
{
    /// <param name="cloud">A cloud database, reached one per connection: no USE.</param>
    /// <returns>The warnings the job produced (header guard, version mapping).</returns>
    public static IReadOnlyList<string> Run(ScriptJob job, SmoScriptRunner runner, IScriptSink sink, CancellationToken token, bool cloud = false)
    {
        var warnings = new List<string>();
        string? context = null;
        for (var index = 0; index < job.Targets.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            var target = job.Targets[index];
            string text;
            if (job.Verb.Class == VerbClass.Ddl) text = runner.Script(target, job.Verb.Verb, job.Options, sink.Remaining, warnings);
            else
            {
                var delimit = job.Options.DelimitStatements;
                var use = job.Options.ScriptUseDatabase && !cloud && target.Database != context;
                context = target.Database;
                text = (use ? ScriptFormatter.Frame(ScriptFormatter.Use(target.Database), delimit) : "")
                    + ScriptFormatter.Frame(DmlTemplates.Batch(target, job.Verb.Verb, job.Options.SchemaQualify), delimit);
            }
            if (!sink.Append(text)) throw new ScriptTooLargeException();
            sink.Progress(index + 1, job.Targets.Count);
        }
        return warnings;
    }
}

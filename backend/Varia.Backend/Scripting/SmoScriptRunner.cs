using System.Globalization;
using System.Text;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Microsoft.SqlServer.Management.Sdk.Sfc;

namespace Varia.Backend.Scripting;

/// <summary>SMO refused to find the object the preflight found (it was dropped in between).</summary>
internal sealed class SmoObjectMissingException() : Exception("The object no longer exists.");

/// <summary>DDL through SMO's Scripter (spec C4), as sqltoolsservice's Script As runs it: a fresh Server per job, so a
/// definition changed in a query tab is never served from a cache, and no prefetch, which for one object would read
/// every object of its type. Runs on the job's dedicated thread.</summary>
internal sealed class SmoScriptRunner
{
    /// <summary>Child collections SMO otherwise reads property by property; never Server, Database or Table, whose
    /// full property sets would be read for every object of the type.</summary>
    internal static readonly Type[] ChildInitTypes =
    [
        typeof(Column), typeof(Microsoft.SqlServer.Management.Smo.Index), typeof(IndexedColumn), typeof(ForeignKey), typeof(ForeignKeyColumn), typeof(Check),
        typeof(DefaultConstraint), typeof(ExtendedProperty), typeof(Trigger), typeof(Statistic), typeof(StatisticColumn), typeof(StoredProcedureParameter),
        typeof(UserDefinedFunctionParameter), typeof(EdgeConstraint)
    ];

    private readonly ScriptSession session;
    private readonly CancellationToken token;
    private Server? server;

    public SmoScriptRunner(ScriptSession session, CancellationToken token)
    {
        this.session = session;
        this.token = token;
    }

    /// <summary>The script's version for messages about SMO's refusals.</summary>
    public SqlServerVersion? Target { get; private set; }

    private Server Server()
    {
        if (server is not null) return server;
        var connection = new ServerConnection(session.Connection) { StatementTimeout = 30, LockTimeout = 10, AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect };
        server = new Server(connection);
        var edition = SmoOptionsMapper.Edition(session.Profile.EngineEdition);
        foreach (var type in ChildInitTypes) server.SetDefaultInitFields(type, true, edition);
        return server;
    }

    /// <summary>One target's batches, framed, at most <paramref name="max"/> characters. A header that fails HeaderGuard
    /// makes SMO script the target again without headers.</summary>
    public string Script(ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, List<string> warnings)
    {
        CultureInfo.CurrentCulture = ScriptingCulture.Current;
        CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
        var smo = Server();
        var urn = new Urn(UrnBuilder.Build(smo.Urn.Value, target.Kind, target.Row.Urn, target.Ref, target.ParentUrnType, target.Column));
        if (verb == ScriptVerb.Alter)
        {
            // Without Touch, SMO writes nothing for ALTER (sqltoolsservice does the same).
            (smo.GetSmoObject(urn) ?? throw new SmoObjectMissingException()).Touch();
        }
        var text = Run(smo, urn, verb, dto, max, dto.IncludeHeaders, warnings);
        if (text is null)
        {
            text = Run(smo, urn, verb, dto, max, headers: false, warnings) ?? throw new InvalidOperationException("A script without headers failed the header guard.");
            warnings.Add(HeaderGuard.Warning);
        }
        return text;
    }

    /// <summary>The framed script, or null when a header failed the guard.</summary>
    private string? Run(Server smo, Urn urn, ScriptVerb verb, ScriptingOptionsDto dto, long max, bool headers, List<string> warnings)
    {
        var text = new StringBuilder();
        var batches = 0;
        var first = true;
        foreach (var pass in SmoOptionsMapper.Passes(verb))
        {
            var mapped = SmoOptionsMapper.Map(dto, pass, session.Profile, headers, session.Cloud, databaseContext: first);
            first = false;
            Target = mapped.Target;
            foreach (var warning in mapped.Warnings) if (!warnings.Contains(warning)) warnings.Add(warning);
            var scripter = new Scripter(smo) { Options = mapped.Options, PrefetchObjects = false };
            scripter.ScriptingProgress += (_, _) => token.ThrowIfCancellationRequested();
            foreach (var batch in scripter.EnumScript(new[] { urn }))
            {
                token.ThrowIfCancellationRequested();
                if (headers && !HeaderGuard.Safe(batch)) return null;
                var framed = ScriptFormatter.Frame(batch, dto.DelimitStatements);
                if (text.Length + framed.Length > max) throw new ScriptTooLargeException();
                text.Append(framed);
                batches++;
            }
        }
        if (batches == 0) throw new EmptyScriptException();
        return text.ToString();
    }
}

/// <summary>SMO wrote no batch for the verb.</summary>
internal sealed class EmptyScriptException() : Exception("SMO produced no script.");

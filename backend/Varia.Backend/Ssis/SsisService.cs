using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Common;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Ssis;

/// <summary>What the SSIS services need from SqlService: a connection's server profile, its SSIS read pool, the actions
/// connection, and how it signed in.</summary>
internal interface ISsisHost
{
    /// <summary>Throws NOT_CONNECTED for an unknown connection.</summary>
    ServerProfile Profile(string connectionId);
    /// <summary>An unopened connection from the SSIS read pool (the program name plus " - Integration Services"), in the catalog's database.</summary>
    SqlConnection SsisConnection(string connectionId, string catalogDatabase);
    /// <summary>The same pool's connection in the login's own database, for when the catalog's cannot be opened.</summary>
    SqlConnection SsisServerConnection(string connectionId);
    /// <summary>An unopened connection of its own for one write (D-ssis 4.4): unpooled, never retried, without a command timeout,
    /// in the catalog's database, under the program name plus " - Integration Services Actions".</summary>
    SqlConnection SsisActionConnection(string connectionId, string catalogDatabase);
    /// <summary>Opens one of those connections; a Kerberos token failure throws AUTH_KERBEROS (or AUTH_UNSUPPORTED), and a
    /// Microsoft Entra one AUTH_ENTRA, which the request answers as a value.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
    /// <summary>sql, integrated or entra: how the connection signed in (SSISDB starts nothing for SQL Server logins, 27123).</summary>
    string Authentication(string connectionId);
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo). CatalogDatabase points the
/// whole SSIS path, the tree included, at a fake catalog; it is never a request field.</summary>
internal sealed class SsisOptions
{
    public string CatalogDatabase { get; set; } = SsisCatalog.Current.CatalogDatabase;
    public int PerConnection { get; init; } = SsisCatalog.Current.Limit("readPerConnection");
    public int Total { get; init; } = SsisCatalog.Current.Limit("readTotal");
    public int MaxRegistered { get; init; } = SsisCatalog.Current.Limit("registered");
    public TimeSpan Budget { get; set; } = TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("describeMs"));
    public TimeSpan GateWait { get; set; } = TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("gateWaitMs"));
    /// <summary>Delays every describe statement (timeout and cancellation checks).</summary>
    public TimeSpan? TestDelay { get; set; }
    /// <summary>Describes on SQL Server on Linux too, where no real catalog can exist, so the fake catalog's checks run on CI's
    /// Linux engine. The tree needs no such option: it lists the catalog's database wherever it exists.</summary>
    public bool IgnoreLinuxHost { get; set; }

    public int WritePerConnection { get; init; } = SsisCatalog.Current.Limit("writePerConnection");
    public int WriteTotal { get; init; } = SsisCatalog.Current.Limit("writeTotal");
    public int MaxRegisteredWrites { get; init; } = SsisCatalog.Current.Limit("registeredWrites");
    public TimeSpan PreflightBudget { get; set; } = TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("preflightMs"));
    /// <summary>How long Stop on a write waits for SQL Server to end the statement before the request answers CANCELLED.</summary>
    public TimeSpan StopGrace { get; set; } = TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("stopGraceMs"));
    /// <summary>Writes for SQL Server logins too, which a box server's SSISDB refuses (27123) but the fake catalog need not, so its
    /// checks run on CI, which connects with SQL Server authentication.</summary>
    public bool IgnoreSqlAuthentication { get; set; }
    /// <summary>Runs between a write's preflight and its first step, on the write's connection (the checks change the catalog there).</summary>
    public Func<CancellationToken, Task>? BeforeWrite { get; set; }
    /// <summary>Runs before Stop Operation reads the operation again after the catalog refuses (the checks end the write's session there).</summary>
    public Func<CancellationToken, Task>? BeforeReread { get; set; }
}

/// <summary>ssis.describe (D-ssis 4.3): validate, register, take the SSIS read gates (2 per connection, 4 in all; BUSY after
/// 30 s), open the SSIS read pool in the catalog's database, read the connection's SsisProfile once, then run the view's one
/// batch under the read prologue. Failures are values; past its 40 s budget a request answers TIMEOUT, and a disconnect
/// answers CANCELLED. It never writes (SsisSql's lint).</summary>
internal sealed class SsisService : IDisposable
{
    private readonly ISsisHost host;
    private readonly SsisCatalog catalog;
    private readonly ExplorerCatalog explorer;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SsisProfile> profiles = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim total;
    private static readonly JsonSerializerOptions RevisionJson = new(JsonSerializerDefaults.Web);

    public SsisService(ISsisHost host, SsisOptions? options = null, SsisCatalog? catalog = null, ExplorerCatalog? explorer = null)
    {
        this.host = host;
        Options = options ?? new SsisOptions();
        this.catalog = catalog ?? SsisCatalog.Current;
        this.explorer = explorer ?? ExplorerCatalog.Current;
        total = new SemaphoreSlim(Options.Total);
        running = new RequestRegistry(Options.MaxRegistered, "Integration Services");
    }

    public SsisOptions Options { get; }
    public SsisCatalog Catalog => catalog;
    /// <summary>Requests registered and not yet answered.</summary>
    public int RunningCount => running.Count;

    /// <summary>The connection's cached profile, if a request read one (the checks).</summary>
    internal SsisProfile? CachedProfile(string connectionId) => profiles.GetValueOrDefault(connectionId);

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid Integration Services request: " + detail);

    /// <summary>Re-validates ssisDescribeSchema: ids, a view of the catalogue, a ref of the kind it describes (Object Explorer's
    /// rules), and for the catalog itself the catalog's name.</summary>
    public ObjectRefDto Validate(SsisDescribeArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var kind = args.View is null ? null : catalog.KindOf(args.View);
        if (kind is null) throw Invalid("view.");
        if (args.Target is null || args.Target.Kind != kind) throw Invalid("the " + args.View + " view describes a " + kind + ".");
        try { ExplorerRefs.Object(args.Target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        if (kind == "ssisCatalog" && !string.Equals(args.Target.Name, Options.CatalogDatabase, StringComparison.OrdinalIgnoreCase)) throw Invalid("the SSIS Catalog is " + Options.CatalogDatabase + ".");
        return args.Target;
    }

    public async Task<SsisDescribeResult> DescribeAsync(SsisDescribeArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var target = Validate(args);
        var server = host.Profile(args.ConnectionId);
        var served = server.Explorer(explorer);
        SsisDescribeResult Failed(SsisError error) => new(null, null, watch.ElapsedMilliseconds, error);
        if (served.Band < 13) return Failed(SsisErrors.Create(catalog, "NOT_SUPPORTED", "The SSIS Catalog needs SQL Server 2016 or later."));
        if (served.Linux && !Options.IgnoreLinuxHost) return Failed(SsisErrors.Create(catalog, "NOT_SUPPORTED", "The SSIS Catalog isn't supported on SQL Server on Linux."));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        try
        {
            // A request cancelled before it ran (a CANCEL frame read right after its REQUEST) takes no gate.
            token.ThrowIfCancellationRequested();
            source.CancelAfter(Options.Budget);
            var (model, error) = await RunAsync(args.ConnectionId, args.View, target, served, source.Token);
            return error is not null ? Failed(error) : new(model, Revision(model!), watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && source.IsCancellationRequested && !token.IsCancellationRequested)
        {
            if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
            return Failed(SsisErrors.Create(catalog, "TIMEOUT", SsisErrors.Timeout(catalog)));
        }
        finally { running.Unregister(args.RequestId, entry); }
    }

    /// <summary>Cancels a disconnected connection's requests and drops its gate and profile.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        gates.TryRemove(connectionId, out _);
        profiles.TryRemove(connectionId, out _);
    }

    /// <summary>Cancels every running request (backend shutdown).</summary>
    public void CancelAll() => running.ForgetAll();

    public void Dispose()
    {
        running.ForgetAll();
        gates.Clear();
        profiles.Clear();
    }

    /// <summary>A SHA-256 of what a later write depends on (D-ssis 4.3), which its preflight compares to what the document
    /// showed: names, descriptions, a project's object_version_lsn and last deployment, parameter values, references,
    /// variables and catalog properties. Validation results, counts, creation details and the profile are left out, because
    /// they change without a write (a Validate run, another folder's deployment) and would report a false CONFLICT. A
    /// truncated answer has none: rows it left out are not covered, so a write must read them first.</summary>
    internal static string? Revision(object model)
    {
        object? basis = model switch
        {
            SsisCatalogModel { Truncated: true } or SsisProjectModel { Truncated: true } or SsisPackageModel { Truncated: true } or SsisEnvironmentModel { Truncated: true } => null,
            SsisCatalogModel catalog => new object?[] { catalog.View, catalog.Name, catalog.Properties?.Select(item => new[] { item.Name, item.Value }).ToList() },
            SsisFolderModel folder => new object?[] { folder.View, folder.Id, folder.Name, folder.Description },
            SsisProjectModel project => new object?[] { project.View, project.Id, project.Folder, project.Name, project.Description, project.VersionLsn, project.Deployed, Parameters(project.Parameters),
                project.References.Select(item => new object?[] { item.Id, item.Type, item.Folder, item.Environment }).ToList() },
            SsisPackageModel package => new object?[] { package.View, package.Id, package.Folder, package.Project, package.Name, package.EntryPoint, Parameters(package.Parameters) },
            SsisEnvironmentModel environment => new object?[] { environment.View, environment.Id, environment.Folder, environment.Name, environment.Description,
                environment.Variables.Select(item => new object?[] { item.Name, item.Type, item.Description, item.Sensitive, item.Value }).ToList() },
            _ => throw new InvalidOperationException("Unknown SSIS model " + model.GetType().Name + ".")
        };
        return basis is null ? null : Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(basis, RevisionJson))));

        static List<object?[]> Parameters(List<SsisParameterDto> parameters) =>
            [.. parameters.Select(item => new object?[] { item.Name, item.DataType, item.Required, item.Sensitive, item.DesignDefault, item.Value, item.ValueType, item.ValueSet, item.Variable })];
    }

    private static RequestException Busy() => new("BUSY", "Other Integration Services requests are running on this server. Retry after they finish.");

    private async Task<(object? Model, SsisError? Error)> RunAsync(string connectionId, string view, ObjectRefDto target, ExplorerProfile served, CancellationToken token)
    {
        var gate = gates.GetOrAdd(connectionId, _ => new SemaphoreSlim(Options.PerConnection));
        if (!await gate.WaitAsync(Options.GateWait, token)) throw Busy();
        try
        {
            if (!await total.WaitAsync(Options.GateWait, token)) throw Busy();
            try
            {
                var name = Options.CatalogDatabase;
                await using var connection = host.SsisConnection(connectionId, name);
                try { await host.OpenAsync(connection, token); }
                catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA") { return (null, SsisErrors.Create(catalog, error.Code, error.Message)); }
                // 4060 says the login cannot open the database, whether it is gone, offline, restoring or closed to the login: a
                // read outside it tells which.
                catch (SqlException error) when (!token.IsCancellationRequested && SsisErrors.CodeOf(error, null) is "NO_DB_ACCESS" or "DATABASE_UNAVAILABLE")
                {
                    return (null, await OpenFailureAsync(connectionId, name, token));
                }
                catch (SqlException error) when (!token.IsCancellationRequested) { return (null, SsisErrors.Create(catalog, "CONNECTION_LOST", "Could not connect to the server: " + error.Message)); }
                try
                {
                    var profile = await ProfileAsync(connection, connectionId, name, served, token);
                    for (var attempt = 0; ; attempt++)
                    {
                        try { return await ReadAsync(connection, view, target, profile, token); }
                        catch (SqlException error) when (error.Number == SsisErrors.DataMovement && attempt == 0 && !token.IsCancellationRequested) { }
                    }
                }
                catch (SqlException error) when (!token.IsCancellationRequested)
                {
                    var failure = SsisErrors.FromSql(catalog, error, connection, name, Subject(target));
                    if (failure.Code == "CATALOG_MISSING") profiles.TryRemove(connectionId, out _);
                    return (null, failure);
                }
            }
            finally { total.Release(); }
        }
        finally { gate.Release(); }
    }

    /// <summary>Why the catalog's database could not be opened (4060 and the unavailable errors), read on the SSIS read pool
    /// outside it: missing, unavailable to everyone, or closed to this login. Writes ask it too.</summary>
    internal async Task<SsisError> OpenFailureAsync(string connectionId, string name, CancellationToken token)
    {
        try
        {
            await using var connection = host.SsisServerConnection(connectionId);
            await host.OpenAsync(connection, token);
            await using var command = connection.CreateCommand();
            command.CommandText = SsisSql.ReadPrologue(false) + SsisSql.CatalogState;
            command.CommandTimeout = 0;
            command.Parameters.Add(Parameter("@catalog", SqlDbType.NVarChar, 128, name));
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token))
            {
                profiles.TryRemove(connectionId, out _);
                return SsisErrors.Create(catalog, "CATALOG_MISSING", SsisErrors.Missing(name));
            }
            return ExplorerLabels.Unavailable(Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture)) is { } reason
                ? SsisErrors.Create(catalog, "DATABASE_UNAVAILABLE", SsisErrors.NotAvailable(name, reason))
                : SsisErrors.Create(catalog, "NO_DB_ACCESS", SsisErrors.NoAccess(name));
        }
        catch (SqlException error) when (!token.IsCancellationRequested) { return SsisErrors.FromSql(catalog, error, null, name, "the SSIS Catalog"); }
    }

    private async Task<SsisProfile> ProfileAsync(SqlConnection connection, string connectionId, string name, ExplorerProfile served, CancellationToken token)
    {
        if (profiles.TryGetValue(connectionId, out var cached) && cached.CatalogDatabase == name) return cached;
        var profile = await SsisProfile.ProbeAsync(connection, name, host.Authentication(connectionId), served.Linux, served.Band, served.Cloud, token);
        profiles[connectionId] = profile;
        return profile;
    }

    private string Subject(ObjectRefDto target) => (explorer.Kind(target.Kind)?.Title ?? target.Kind) + " " + ScriptingErrors.Display(target.Name ?? "");

    private SsisError NotFound(ObjectRefDto target) => SsisErrors.Create(catalog, "NOT_FOUND", Subject(target) + " no longer exists. Refresh Object Explorer.");

    private static SqlParameter Parameter(string name, SqlDbType type, int size, object? value)
    {
        // SqlClient cuts longer text to the size without an error, and a cut name reads another object.
        if (value is string text && size > 0 && text.Length > size) throw new InvalidOperationException("An Integration Services parameter is longer than its declaration: " + name + ".");
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        return parameter;
    }

    /// <summary>The parameters every view's batch may name, from the target's own fields.</summary>
    internal SqlParameter[] Bind(string view, ObjectRefDto target, SsisProfile profile) =>
    [
        Parameter("@folder", SqlDbType.NVarChar, catalog.Limit("name"), view switch { "folder" => target.Name, _ => target.SsisFolder }),
        Parameter("@project", SqlDbType.NVarChar, catalog.Limit("name"), view switch { "project" => target.Name, _ => target.SsisProject }),
        Parameter("@name", SqlDbType.NVarChar, catalog.Limit("packageName"), view is "package" or "environment" ? target.Name : null),
        Parameter("@take", SqlDbType.Int, 0, catalog.Limit("rows") + 1),
        Parameter("@chars", SqlDbType.Int, 0, catalog.Limit("value")),
        Parameter("@admin", SqlDbType.Bit, 0, profile.Roles.Admin)
    ];

    private async Task<(object? Model, SsisError? Error)> ReadAsync(SqlConnection connection, string view, ObjectRefDto target, SsisProfile profile, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        var delay = Options.TestDelay is { } wait ? "WAITFOR DELAY '" + wait.ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture) + "';\n" : "";
        command.CommandText = SsisSql.ReadPrologue(profile.Rcsi) + delay + SsisSql.Describe(view, new SsisRender(profile.Band, profile.Features));
        command.CommandTimeout = 0;
        command.Parameters.AddRange(Bind(view, target, profile));
        await using var reader = await command.ExecuteReaderAsync(token);
        var budget = new Budget(catalog);
        var rows = catalog.Limit("rows");
        object? model;
        switch (view)
        {
            case "catalog":
            {
                var folders = await reader.ReadAsync(token) ? reader.GetInt64(0) : 0;
                List<SsisPropertyDto>? properties = null;
                if (profile.Roles.Admin && await reader.NextResultAsync(token))
                {
                    properties = [];
                    while (await reader.ReadAsync(token))
                    {
                        // The statement reads one character past the bound, so a longer value is cut to it with an ellipsis.
                        var value = reader.IsDBNull(1) ? "" : Bounded(reader.GetString(1));
                        if (!budget.Take(properties.Count, rows, reader.GetString(0).Length + value.Length)) break;
                        properties.Add(new(reader.GetString(0), value));
                    }
                }
                model = new SsisCatalogModel("catalog", target.Name!, profile.View(), folders, properties, budget.Truncated);
                break;
            }
            case "folder":
                if (!await reader.ReadAsync(token)) return (null, NotFound(target));
                model = new SsisFolderModel("folder", reader.GetInt64(0), reader.GetString(1), Text(reader, 2), reader.GetString(3), Time(reader, 4)!, reader.GetInt64(5), reader.GetInt64(6));
                break;
            case "project":
            {
                if (!await reader.ReadAsync(token)) return (null, NotFound(target));
                var (id, folder, name, description, format, deployedBy, deployed, created, lsn, status, validated) = (reader.GetInt64(0), reader.GetString(1), reader.GetString(2), Text(reader, 3),
                    reader.IsDBNull(4) ? (int?)null : reader.GetInt32(4), reader.GetString(5), Time(reader, 6)!, Time(reader, 7)!, reader.GetInt64(8), Code(reader, 9), Time(reader, 10));
                await reader.NextResultAsync(token);
                var packages = new List<SsisPackageRowDto>();
                while (await reader.ReadAsync(token) && budget.Take(packages.Count, rows, reader.GetString(0).Length + Length(reader, 2)))
                    packages.Add(new(reader.GetString(0), reader.GetBoolean(1), Text(reader, 2), Version(reader, 3)));
                await reader.NextResultAsync(token);
                var parameters = await ParametersAsync(reader, budget, rows, token);
                await reader.NextResultAsync(token);
                var references = new List<SsisReferenceDto>();
                while (await reader.ReadAsync(token) && budget.Take(references.Count, rows, Length(reader, 2) + reader.GetString(3).Length))
                    references.Add(new(reader.GetInt64(0), Code(reader, 1), Text(reader, 2), reader.GetString(3), Code(reader, 4)));
                model = new SsisProjectModel("project", id, folder, name, description, format, deployedBy, deployed, created, lsn, status, validated, packages, parameters, references, budget.Truncated);
                break;
            }
            case "package":
            {
                if (!await reader.ReadAsync(token)) return (null, NotFound(target));
                var (id, name, description, format, version, comments, entry, status, validated) = (reader.GetInt64(0), reader.GetString(1), Text(reader, 2), reader.GetInt32(3), Version(reader, 4),
                    Text(reader, 7), reader.GetBoolean(8), Code(reader, 9), Time(reader, 10));
                await reader.NextResultAsync(token);
                var parameters = await ParametersAsync(reader, budget, rows, token);
                model = new SsisPackageModel("package", id, target.SsisFolder!, target.SsisProject!, name, description, format, version, comments, entry, status, validated, parameters, budget.Truncated);
                break;
            }
            case "environment":
            {
                if (!await reader.ReadAsync(token)) return (null, NotFound(target));
                var (id, folder, name, description, createdBy, created) = (reader.GetInt64(0), reader.GetString(1), reader.GetString(2), Text(reader, 3), reader.GetString(4), Time(reader, 5)!);
                await reader.NextResultAsync(token);
                var variables = new List<SsisVariableDto>();
                while (await reader.ReadAsync(token))
                {
                    var value = reader.GetBoolean(3) ? null : Variant(reader.GetValue(4));
                    if (!budget.Take(variables.Count, rows, reader.GetString(0).Length + Length(reader, 2) + (value?.Length ?? 0))) break;
                    variables.Add(new(reader.GetString(0), reader.GetString(1), Text(reader, 2), reader.GetBoolean(3), value));
                }
                model = new SsisEnvironmentModel("environment", id, folder, name, description, createdBy, created, variables, budget.Truncated);
                break;
            }
            default: throw new InvalidOperationException("Unknown SSIS view " + view + ".");
        }
        // Rows past the cap are not read: the attention ends the statement.
        if (budget.Truncated) TryCancel(command);
        return (model, null);
    }

    private static async Task<List<SsisParameterDto>> ParametersAsync(SqlDataReader reader, Budget budget, int rows, CancellationToken token)
    {
        var parameters = new List<SsisParameterDto>();
        while (await reader.ReadAsync(token))
        {
            var sensitive = reader.GetBoolean(3);
            string? design = sensitive ? null : Variant(reader.GetValue(5)), value = sensitive ? null : Variant(reader.GetValue(6));
            if (!budget.Take(parameters.Count, rows, reader.GetString(0).Length + Length(reader, 4) + (design?.Length ?? 0) + (value?.Length ?? 0))) break;
            parameters.Add(new(reader.GetString(0), reader.GetString(1), reader.GetBoolean(2), sensitive, Text(reader, 4), design, value, Code(reader, 7), reader.GetBoolean(8), Text(reader, 9)));
        }
        return parameters;
    }

    /// <summary>Bounds one answer: at most the catalogue's rows per list and its byte estimate in all; what is left out sets Truncated.</summary>
    internal sealed class Budget(SsisCatalog catalog)
    {
        private readonly long limit = catalog.Limit("describeBytes");
        private long bytes;
        public bool Truncated { get; private set; }

        public bool Take(int count, int rows, int characters)
        {
            if (count >= rows || bytes + 64 + 2L * characters > limit) { Truncated = true; return false; }
            bytes += 64 + 2L * characters;
            return true;
        }
    }

    private static int Length(SqlDataReader reader, int index) => reader.IsDBNull(index) ? 0 : reader.GetString(index).Length;
    private static string? Text(SqlDataReader reader, int index) => reader.IsDBNull(index) ? null : reader.GetString(index);
    /// <summary>A char(1) code such as validation_status, without padding.</summary>
    private static string Code(SqlDataReader reader, int index) => reader.IsDBNull(index) ? "" : reader.GetString(index).TrimEnd();
    private static string Version(SqlDataReader reader, int first) =>
        string.Join(".", Enumerable.Range(first, 3).Select(index => reader.IsDBNull(index) ? "0" : reader.GetInt32(index).ToString(CultureInfo.InvariantCulture)));

    /// <summary>A datetimeoffset with its offset, as the catalog stores it.</summary>
    internal static string? Time(SqlDataReader reader, int index) => reader.IsDBNull(index) ? null : Iso(reader.GetDateTimeOffset(index));
    internal static string Iso(DateTimeOffset value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz", CultureInfo.InvariantCulture);

    /// <summary>A sql_variant value as invariant text, at most the catalogue's 4,000 characters.</summary>
    internal static string? Variant(object? value)
    {
        var text = value switch
        {
            null or DBNull => null,
            string item => item,
            bool item => item ? "True" : "False",
            DateTime item => item.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
            DateTimeOffset item => Iso(item),
            byte[] item => "0x" + Convert.ToHexString(item),
            Guid item => item.ToString("D"),
            IFormattable item => item.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString()
        };
        return text is null ? null : Bounded(text);
    }

    /// <summary>A value as the answer holds it: at most the catalogue's 4,000 characters, the last an ellipsis when it was cut.</summary>
    internal static string Bounded(string text)
    {
        var max = SsisCatalog.Current.Limit("value");
        return text.Length <= max ? text : text[..(max - 1)] + "…";
    }

    private static void TryCancel(SqlCommand command)
    {
        try { command.Cancel(); } catch (Exception error) when (error is InvalidOperationException or SqlException) { /* Best effort. */ }
    }
}

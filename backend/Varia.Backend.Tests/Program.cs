using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Tests;

// The child processes of ConnectionFailureChecks' native Kerberos checks.
if (args is [ConnectionFailureChecks.ProbeArgument])
{
    Console.WriteLine(KerberosProbe.Inspect());
    return;
}
if (args is [ConnectionFailureChecks.IdentityArgument])
{
    var identity = KerberosProbe.Identity();
    Console.WriteLine(identity.State + "|" + identity.Principal);
    return;
}

var passed = 0;
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    passed++;
}
// CI's live jobs (`--live-group k/n`) run only their share of the live suites (LiveGroups), and no offline checks: Check (ubuntu) runs those.
var liveGroup = LiveGroups.Parse(args);
// Focused SQL Server lanes: their scratch and permission checks are required, never an offline-only or skipped success.
if (args is [var lane and ("--activity-actions-live" or "--explorer-status-live" or "--server-files-live" or "--seams-live" or "--new-database-live" or "--action-progress-live" or "--attach-live" or "--restore-live" or "--logins-live" or "--login-listing-live" or "--database-state-live" or "--delete-live" or "--detach-live" or "--rename-database-live" or "--login-actions-live" or "--login-delete-live" or "--login-properties-live" or "--securables-live" or "--login-kinds-live")])
{
    var focusedServer = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SERVER");
    if (string.IsNullOrWhiteSpace(focusedServer)) throw new Exception(lane + " requires VARIA_TEST_SQL_SERVER.");
    if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1") throw new Exception(lane + " requires VARIA_TEST_SQL_SCRATCH=1.");
    var focusedUser = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_USER");
    var focusedPassword = string.IsNullOrWhiteSpace(focusedUser) ? null
        : Environment.GetEnvironmentVariable("VARIA_TEST_SQL_PASSWORD") ?? throw new Exception("VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.");
    ConnectOptions FocusedLive(string database) => focusedPassword is null
        ? new(focusedServer, database, "windows", null, null, true)
        : new(focusedServer, database, "sql", focusedUser, focusedPassword, true);
    using var focusedService = new SqlService();
    var focusedInfo = (ConnectionInfo)await focusedService.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(FocusedLive("master"), json), json);
    try
    {
        if (lane == "--rename-database-live")
        {
            await RenameDatabaseLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused database rename checks.");
        }
        else if (lane == "--detach-live")
        {
            await DetachLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused Detach Database checks.");
        }
        else if (lane == "--delete-live")
        {
            await using var deleteScratch = ScratchDatabase.Bare(async (text, database) =>
            {
                var id = Guid.NewGuid().ToString();
                try
                {
                    var result = (QueryResult)await focusedService.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                        new QueryArgs(focusedInfo.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                    return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(focusedService.Results, set))]);
                }
                finally { await focusedService.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
            });
            await ActionLiveChecks.DeleteParityAsync(Check, focusedService, focusedInfo, FocusedLive("master"), json, deleteScratch, requirePermissionChecks: true);
            Console.WriteLine("Passed " + passed + " focused Delete parity checks.");
        }
        else if (lane == "--database-state-live")
        {
            await DatabaseStateLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused Take Offline and Bring Online checks.");
        }
        else if (lane == "--seams-live")
        {
            await SeamLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused wave 5 seam checks.");
        }
        else if (lane == "--action-progress-live")
        {
            await ActionProgressLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused action progress checks.");
        }
        else if (lane == "--logins-live")
        {
            await LoginLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, required: true);
            Console.WriteLine("Passed " + passed + " focused New Login checks.");
        }
        else if (lane == "--login-listing-live")
        {
            await LoginListingLiveChecks.RunAsync(Check, focusedService, focusedInfo, json);
            Console.WriteLine("Passed " + passed + " focused Logins listing checks.");
        }
        else if (lane == "--login-actions-live")
        {
            await LoginActionLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            await UnlockLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused login action checks.");
        }
        else if (lane == "--login-delete-live")
        {
            await LoginDeleteLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, required: true);
            Console.WriteLine("Passed " + passed + " focused login Delete checks.");
        }
        else if (lane == "--login-properties-live")
        {
            await LoginPropertiesLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, required: true);
            Console.WriteLine("Passed " + passed + " focused Login Properties checks.");
        }
        else if (lane == "--login-kinds-live")
        {
            await LoginKindsLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, required: true);
            Console.WriteLine("Passed " + passed + " focused New Login kind checks.");
        }
        else if (lane == "--securables-live")
        {
            await SecurablesLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, required: true);
            Console.WriteLine("Passed " + passed + " focused Securables checks.");
        }
        else if (lane == "--explorer-status-live")
        {
            await ExplorerStatusLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused Object Explorer status checks.");
        }
        else if (lane == "--new-database-live")
        {
            await NewDatabaseLiveChecks.RunAsync(Check, focusedService, focusedInfo, json);
            Console.WriteLine("Passed " + passed + " focused New Database checks.");
        }
        else if (lane == "--restore-live")
        {
            await RestoreLiveChecks.RunAsync(Check, focusedService, focusedInfo, json);
            Console.WriteLine("Passed " + passed + " focused Restore Database checks.");
        }
        else if (lane == "--server-files-live")
        {
            await ServerFilesLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused server file picker checks.");
        }
        else if (lane == "--attach-live")
        {
            await AttachLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json);
            Console.WriteLine("Passed " + passed + " focused Attach Databases checks.");
        }
        else
        {
            await ActivityActionLiveChecks.RunAsync(Check, focusedService, focusedInfo, FocusedLive, json, requirePermissionChecks: true);
            Console.WriteLine("Passed " + passed + " focused Activity Monitor session action checks.");
        }
    }
    finally { await focusedService.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(focusedInfo.Id), json), json); }
    return;
}
if (liveGroup is null)
{
    void Invalid(string sql, string name)
    {
        try { SqlScript.Parse(sql); throw new Exception("Accepted invalid script: " + name); }
        catch (RequestException error) { Check(error.Code == "INVALID_SCRIPT", name); }
    }

    var batches = SqlScript.Parse("SELECT 1;\r\ngo\r\nSELECT 2;\r\nGo 3 -- repeat\r\n");
    Check(batches.Count == 2 && batches[0].RepeatCount == 1 && batches[1].RepeatCount == 3, "case insensitive GO and repetition");
    Check(batches[0].StartLine == 1 && batches[1].StartLine == 3, "source line offsets retained");
    Check(!batches[0].Sql.Contains("go") && !batches[1].Sql.Contains("Go 3") && batches[1].Sql == "SELECT 2;\r\n", "GO commands removed");
    var modules = SqlScript.Parse("SELECT 1;\nGO\n\nCREATE PROC p AS SELECT 1;\r\nGO\r\nCREATE VIEW v AS SELECT 1 AS a;\nGO -- end\nSELECT 2;");
    Check(modules.Count == 4 && modules[1].Sql == "\nCREATE PROC p AS SELECT 1;\r\n" && modules[1].StartLine == 3 && modules[2].Sql == "CREATE VIEW v AS SELECT 1 AS a;\n" && modules[2].StartLine == 6
        && modules[3].Sql == " -- end\nSELECT 2;" && modules[3].StartLine == 7,
        "a bare GO line ends with its line break, so a scripted module comes back without a leading blank line");
    Check(SqlScript.Parse("GO\n-- empty\nGO\nSELECT 1;\nGO\nGO").Count == 1, "ignore empty batches");
    Check(SqlScript.Parse("-- GO\n/* GO */\n").Count == 0, "ignore comments only");
    foreach (var literal in new[] { "'first\nGO\nlast'", "N'it''s\nGO 3\ntext'", "[name\nGO\n]]end]", "\"name\nGO\n\"\"end\"" })
        Check(SqlScript.Parse("SELECT " + literal + ";\nGO\nSELECT 2;").Count == 2, "quoted GO is not a separator: " + literal[0]);
    Check(SqlScript.Parse("SELECT 1;\n/* nested /* GO */\nGO\n*/\nGO\nSELECT 2;").Count == 2, "nested block comments");
    batches = SqlScript.Parse("SELECT 1; /* before\n*/ GO /* after\nGO\n*/\nSELECT 2;");
    Check(batches.Count == 2 && batches[0].Sql.EndsWith("*/ ") && batches[1].Sql.Contains("/* after"), "comments spanning delimiter lines remain balanced");
    Check(SqlScript.Parse("SELECT 1;\nGO /* count */ 2 /* trailing */\nSELECT 2;")[0].RepeatCount == 2, "comments between delimiter tokens");
    Check(SqlScript.Parse("SELECT 'GO'; SELECT [GO]; -- GO\nGO\nSELECT 2;").Count == 2, "inline identifiers and strings");
    Check(SqlScript.Parse("SELECT 1;\nGOTO label;\nGO2;\nlabel: SELECT 2;").Count == 1, "GO prefixes are not delimiters");
    foreach (var go in new[] { "GO;", "GO 0", "GO -1", "GO +2", "GO 2.5", "GO 1001", "GO 999999999999999", "GO 2 SELECT 2", "GO '2'" }) Invalid("SELECT 1;\n" + go, go);
    Invalid(string.Concat(Enumerable.Repeat("SELECT 1;\nGO 1000\n", 2)), "total repetition budget");
    Invalid("SELECT 1;\nGO\n:r file.sql", "SQLCMD include rejected before executing anything");
    Invalid("!! echo command", "shell escape rejected");
    Invalid("SELECT 1;\n  :setvar name value", "an indented SQLCMD command is rejected");
    batches = SqlScript.Parse("SELECT *\nFROM\n::fn_helpcollations();\nGO\nSELECT geography\n::Point(1, 2, 4326);");
    Check(batches.Count == 2 && batches[0].Sql.Contains("::fn_helpcollations") && batches[1].Sql.Contains("::Point"), "a line starting with :: is T-SQL, not a SQLCMD command");
    Invalid("SELECT 'unfinished", "unterminated literal");
    Invalid("SELECT 1; /* unfinished", "unterminated comment");
    try { SqlScript.Parse("SELECT 1;\nGO 0", 20); throw new Exception("Invalid selection accepted"); }
    catch (RequestException error) { Check(error.Message.Contains("Line 21:"), "preflight errors include selected-text line offsets"); }
    var messages = new QueryMessages();
    messages.Add(new string('x', 1_000_001));
    Check(messages.Truncated && messages.Snapshot()[0].Text.Length == 1_000_000 && messages.Snapshot().Last().Text.Contains("truncated"), "message text budget is explicit");
    messages = new QueryMessages();
    for (var i = 0; i < 1001; i++) messages.Add("message");
    Check(messages.Truncated && messages.Snapshot().Count == 1001, "message count budget is explicit");
    for (var i = 0; i < 25; i++) messages.Add("Msg 50000, Level 16, State 1, Line 1\n" + new string('e', 20_000), MessageKind.Error);
    messages.Add("printed later");
    var late = messages.Snapshot();
    Check(late.Count == 1000 + 1 + QueryMessages.MaxLateErrors && late[1000].Text.StartsWith("Messages were truncated") && late.Skip(1001).All(entry => entry.Kind == "error" && entry.Text.Length == 16_384),
        "after the message caps, up to 20 errors are still kept (cut at 16,384 characters), after the truncation note");
    messages = new QueryMessages();
    messages.Add("(1 row affected)");
    messages.Add("printed", MessageKind.Print);
    messages.Add("Warning: Null value is eliminated by an aggregate or other SET operation.", MessageKind.Server);
    messages.Add("Msg 1", MessageKind.Error);
    Check(messages.Snapshot().Select(entry => entry.Kind).SequenceEqual(["info", "print", "server", "error"]), "messages carry their kind: Varia's lines, what the script printed, SQL Server's other messages, errors");
    Check(SqlService.InformationalKind(0) == MessageKind.Print && SqlService.InformationalKind(50000) == MessageKind.Print && SqlService.InformationalKind(50001) == MessageKind.Print
        && SqlService.InformationalKind(8153) == MessageKind.Server && SqlService.InformationalKind(3612) == MessageKind.Server && SqlService.InformationalKind(15477) == MessageKind.Server,
        "PRINT (0) and RAISERROR (50000 and user messages) are print; engine warnings, STATISTICS and sp_rename's caution are server");
    var stored = new List<MessageEntry>();
    messages = new QueryMessages(stored.Add);
    messages.Add("printed");
    messages.Add("Msg 8134, Level 16, State 1, Line 1\nDivide by zero error encountered.", MessageKind.Error);
    messages.Add("(1 row affected)");
    Check(messages.Snapshot().Select(entry => entry.Kind).SequenceEqual(["info", "error", "info"]) && stored.SequenceEqual(messages.Snapshot()),
        "messages keep their kinds and order, and each is reported as it is stored");
    var settings = new ConnectOptions("localhost", "", "sql", "reader", "private-marker", true, "strict", "db.example", Advanced: new(
        CommandTimeout: 0, ConnectTimeout: 12, MultipleActiveResultSets: true, NetworkProtocol: "tcp", PacketSize: 8192,
        ConnectRetryCount: 2, ConnectRetryInterval: 3, ApplicationName: "Test Workbench", WorkstationId: "workstation",
        ApplicationIntent: "ReadOnly", IpAddressPreference: "IPv6First", MultiSubnetFailover: true, ServerSpn: "MSSQLSvc/db.example"));
    var builder = ConnectionSettings.Build(settings);
    Check(builder.DataSource == "tcp:localhost" && builder.InitialCatalog == "", "network protocol and login default database map to provider");
    Check(builder.Encrypt.ToString() == "Strict" && !builder.TrustServerCertificate && builder.HostNameInCertificate == "db.example", "strict encryption ignores trust override and preserves certificate hostname");
    Check(builder.CommandTimeout == 0 && builder.ConnectTimeout == 12 && builder.MultipleActiveResultSets && builder.PacketSize == 8192, "common and advanced properties map to provider");
    Check(builder.ConnectRetryCount == 2 && builder.ConnectRetryInterval == 3 && builder.ApplicationIntent.ToString() == "ReadOnly" && builder.IPAddressPreference.ToString() == "IPv6First", "retry, intent, and address preference map to provider");
    Check(builder.MultiSubnetFailover && builder.ServerSPN == "MSSQLSvc/db.example" && !builder.PersistSecurityInfo, "routing and security properties map to provider");
    Check(!JsonSerializer.Serialize(ConnectionSettings.Preview(settings)).Contains("private-marker"), "connection preview never contains a password");
    builder = ConnectionSettings.Build(settings with { Authentication = "windows", Encrypt = "mandatory", Advanced = new(ColumnEncryption: true, SecureEnclaves: true, AttestationProtocol: "None") });
    Check(builder.ColumnEncryptionSetting.ToString() == "Enabled" && builder.AttestationProtocol.ToString() == "None" && builder.Password == "", "enclaves and Windows authentication map without SQL credentials");
    builder = ConnectionSettings.Build(settings with { Environment = new string('P', 32) });
    Check(!builder.ConnectionString.Contains("PPPP"), "a connection's environment label is accepted up to 32 characters and never reaches the connection string");
    builder = ConnectionSettings.Build(settings with { Environment = "  " + new string('P', 32) + "  " });
    Check(!builder.ConnectionString.Contains("PPPP"), "backend measures an environment label after trimming, as main does");
    foreach (var (environment, problem) in new[] { (new string('P', 33), "over 32 characters"), (" ", "that is blank"), ("PROD\u0007", "with a control character"),
        ("PR\u202eOD", "with a bidirectional override"), ("PR\u200bOD", "with a zero-width space"), ("PR\u2028OD", "with a line separator"), ("PR\u2029OD", "with a paragraph separator"), ("PR\U000E0041OD", "with a tag character") })
    {
        try { ConnectionSettings.Build(settings with { Environment = environment }); throw new Exception("Invalid environment accepted"); }
        catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "backend rejects an environment label " + problem); }
    }
    try { ConnectionSettings.Build(settings with { Advanced = new(PacketSize: 1) }); throw new Exception("Invalid packet size accepted"); }
    catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "backend rejects invalid advanced ranges"); }
    try { ConnectionSettings.Build(settings with { Advanced = new(ColumnEncryption: true, SecureEnclaves: true, AttestationProtocol: "HGS") }); throw new Exception("Missing attestation URL accepted"); }
    catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "HGS requires an attestation URL"); }
    ProtocolChecks.Run(Check);
    PageChecks.Run(Check);
    HostChecks.Run(Check);
    await LiveChecks.RunAsync(Check);
    await LiveSchedulerChecks.RunAsync(Check);
    await LiveTableChecks.RunAsync(Check);
    await ConnectionFailureChecks.RunAsync(Check);
    await ConnectionFailureChecks.IdentityAsync(Check);
    SessionChecks.Run(Check);
    PlanChecks.Run(Check);
    EstimatedPlanChecks.Run(Check);
    ClientStatisticsChecks.Run(Check);
    await EntraChecks.RunAsync(Check);
    StoreChecks.Run(Check);
    CellLengthChecks.Run(Check);
    await TextChecks.RunAsync(Check);
    await ExplorerChecks.RunAsync(Check);
    await PeekChecks.RunAsync(Check);
    SearchChecks.Run(Check);
    await ScriptingChecks.RunAsync(Check);
    await ActionChecks.RunAsync(Check);
    await ServerFilesChecks.RunAsync(Check);
    await SeamChecks.RunAsync(Check);
    await ActionProgressChecks.RunAsync(Check);
    await AttachChecks.RunAsync(Check);
    await RestoreChecks.RunAsync(Check);
    await LoginChecks.RunAsync(Check);
    await LoginActionChecks.RunAsync(Check);
    await LoginDeleteChecks.RunAsync(Check);
    await UnlockChecks.RunAsync(Check);
    LoginPropertiesChecks.Run(Check);
    SecurablesChecks.Run(Check);
    await LoginKindsChecks.RunAsync(Check);
    DatabasePropertiesChecks.Run(Check);
    DesignerChecks.Run(Check);
    NewDatabaseChecks.Run(Check);
    await SsisChecks.RunAsync(Check);
    ActivityChecks.Run(Check);
    ActivitySourceChecks.Run(Check);
    await ActivityActionChecks.RunAsync(Check, json);
    SsisOperationsChecks.Run(Check);
    using (var offline = new SqlService())
    {
        try { await offline.DispatchAsync("tables.columns", JsonSerializer.SerializeToElement(new TableArgs(Guid.NewGuid().ToString(), "master", "dbo", new string('x', 129)), json), json); throw new Exception("Overlong table name accepted"); }
        catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "table columns reject an overlong name before looking up the connection"); }
        try { await offline.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(Guid.NewGuid().ToString(), "save"), json), json); throw new Exception("Unknown transaction end accepted"); }
        catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "closing a session ends its transaction only by commit or rollback"); }
        var closed = await offline.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(Guid.NewGuid().ToString(), "commit"), json), json);
        Check(JsonSerializer.Serialize(closed, json) == "{\"closed\":false}", "closing an unknown session with commit has nothing to commit");
        // SSMS has no cap on query windows; 1,000 sessions is only a backstop on connections.
        Check(offline.SessionLimit == 1000, "the query session limit is a backstop of 1,000");
        async Task<string> StateError(string sessionId)
        {
            try { await offline.DispatchAsync("query.session.state", JsonSerializer.SerializeToElement(new SessionStateArgs(sessionId), json), json); return "answered"; }
            catch (RequestException error) { return error.Code; }
        }
        Check(await StateError("invalid") == "INVALID_PARAMS" && await StateError(Guid.NewGuid().ToString()) == "SESSION_CLOSED", "an unknown session's state is an error value, at once");
        // A Stop can overtake its query.execute (each request runs on its own task); the query takes it as it registers.
        Task<object> Offline(string method, object args) => offline.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        var earlyId = Guid.NewGuid().ToString();
        var earlyAck = JsonSerializer.Serialize(await Offline("query.cancel", new CancelArgs(earlyId)), json);
        var keptEarly = offline.EarlyStopCount;
        string? earlyError = null;
        try { await Offline("query.execute", new QueryArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "master", "SELECT 1;\nGO 0", earlyId, 1000, 30)); }
        catch (RequestException error) { earlyError = error.Code; }
        Check(earlyAck == "{\"cancelled\":false}" && keptEarly == 1 && offline.EarlyStopCount == 0 && earlyError == "INVALID_SCRIPT",
            "a Stop for a query not yet registered is kept until that query registers, and a query that fails validation leaves the registry: " + earlyAck + " " + keptEarly + " " + earlyError);
        await Offline("query.cancel", new CancelArgs("not-a-guid"));
        for (var i = 0; i < SqlService.MaxEarlyStops + 20; i++) await Offline("query.cancel", new CancelArgs(Guid.NewGuid().ToString()));
        Check(offline.EarlyStopCount == SqlService.MaxEarlyStops, "early Stops are bounded, the oldest dropped first, and malformed ids are not kept: " + offline.EarlyStopCount);
    }
    // Live runs share one server with other runs: they leave each other's scratch objects alone and time cancels against the load.
    Check(new[] { "VariaScratch_20261018120000_0123abcd_su", "VariaScratch_x", "varia_scratch_0123456789ab", "VARIA_SCRATCH_x", "##VariaScratch_20261018120000_0123abcd_ls##" }.All(ScratchDatabase.IsScratchName)
        && !new[] { "master", "variascratch_x", "VariaScratch", "AppVariaScratch_x", "varia_scratchy", "##MS_PolicyTsqlExecutionLogin##", "#VariaScratch_x", "##variascratch_x" }.Any(ScratchDatabase.IsScratchName)
        && InjectionMatrix.Inventory.Contains("sp.name NOT LIKE N'##VariaScratch[_]%'", StringComparison.Ordinal),
        "scratch names are the .NET checks' VariaScratch_ (and ##VariaScratch_ for a login in SQL Server's own name form) and the vitest and smoke suites' varia_scratch_ prefixes, "
        + "which the injection matrix's server principals leave out");
    static SqlRun Names(params string[] names) => new("Completed", null, [[.. names.Select(name => new string?[] { name })]]);
    Check(ScratchDatabase.Lasting(Names("master", "VariaScratch_20261018120000_0123abcd", "model", "varia_scratch_0123456789ab"))
            == ScratchDatabase.Lasting(Names("master", "model"))
        && ScratchDatabase.Lasting(Names("master", "model")) != ScratchDatabase.Lasting(Names("master", "model", "Sales"))
        && ScratchDatabase.Lasting(Names("master", "model")) != ScratchDatabase.Lasting(Names("master")),
        "\"the server is unchanged\" checks ignore other runs' scratch databases but see any other database come or go");
    Check(new[] { "", "_ro", "_off", "_su", "_rs", "_rv", "_rvs", "_snap", "_rt", "_inj", "_act", "_actr", "_dbp", "_tbd", "_tbd.]", "_live", "_ssis", "_ssisref", "_ssiscc", "_files", "_seam", "_seamt", "_nd", "_ap", "_at", "_at']", "_at2", "_rst", "_rstr", "_dbs", "_del", "_delc", "_delcs", "_delo", "_det", "_dets", "_ldu", "_ldk" }.All(suffix => ScratchDatabase.Sweepable("VariaScratch_20261018120000_0123abcd" + suffix))
        && !new[] { "VariaScratch_20261018120000_0123abcd_acts", "VariaScratch_20261018120000_0123abcd_iso", "VariaScratch_20261018120000_0123abcd_dbpx", "VariaScratch_x_act", "varia_scratch_0123456789ab", "VariaScratch_20261018120000_0123ABCD",
            "VariaScratch_20261018120000_0123abcd_ssisx", "VariaScratch_20261018120000_0123abcd_ssis_ref", "VariaScratch_20261018120000_0123abcd_ssiscc_", "VariaScratch_20261018120000_0123abcd_file", "VariaScratch_20261018120000_0123abcd_seamx", "VariaScratch_20261018120000_0123abcd_ndx", "VariaScratch_20261018120000_0123abcd_apx", "VariaScratch_20261018120000_0123abcd_at']]", "VariaScratch_20261018120000_0123abcd_at3", "VariaScratch_20261018120000_0123abcd_rstx", "VariaScratch_20261018120000_0123abcd_detx", "VariaScratch_20261018120000_0123abcd_ld", "SSISDB" }.Any(ScratchDatabase.Sweepable)
        && ScratchDatabase.IsScratchJob("VariaScratch_20261018120000_0123abcd_job")
        && !new[] { "VariaScratch_x_job", "VariaScratch_cleanup_job", "VariaScratch_nightly_job", "VariaScratch_20261018120000_0123abcd", "VariaScratch_20261018120000_0123ABCD_job",
            "VariaScratch_20261018120000_0123abcd_job2", "VariaScratch_20261018120000_0123abcd_x_job", "xVariaScratch_20261018120000_0123abcd_job" }.Any(ScratchDatabase.IsScratchJob),
        "the sweep finds every scratch database a crashed run can leave, the object actions' _act and _actr, Database Properties' _dbp, the table designer's _tbd and _tbd.], the live tables' _live, the SSIS checks' _ssis, _ssisref and _ssiscc, the server file picker's _files, the wave 5 seam checks' _seam and _seamt, New Database's _nd, the action progress checks' _ap, Attach Databases' _at, _at'] and _at2, Restore Database's _rst and _rstr, Take Offline's _dbs, Delete parity's _del, _delc, _delcs and _delo, Detach's _det and _dets, and Object Explorer status's _rs, _rv and _rvs included, and nothing else (never SSISDB); only an Agent job named as a run names its own (VariaScratch_<14 digits>_<8 hex>_job) can be swept");
    Check(new[] { "_lgn", "_lgm", "_lgmo", "_lgmr", "_lpr" }.All(suffix => ScratchDatabase.Sweepable("VariaScratch_20261018120000_0123abcd" + suffix)) && !ScratchDatabase.Sweepable("VariaScratch_20261018120000_0123abcd_lgmx") && !ScratchDatabase.Sweepable("VariaScratch_20261018120000_0123abcd_lprx") && new[] { "VariaScratch_20261018120000_0123abcd", "VariaScratch_20261018120000_0123abcd_lnew", "VariaScratch_20261018120000_0123abcd_l1", "VariaScratch_20261018120000_0123abcd_lpa" }.All(ScratchDatabase.SweepableLogin)
        && !new[] { "VariaScratch_20261018120000_0123abcd_l", "VariaScratch_20261018120000_0123abcd_lNEW", "VariaScratch_20261018120000_0123abcd_l123456789", "VariaScratch_20261018120000_0123abcd_x", "sa", "VariaScratch_x_lnew" }.Any(ScratchDatabase.SweepableLogin)
        && ScratchDatabase.StaleXeSession("VariaScratch_20261018120000_0123abcd_xe", new DateTime(2026, 10, 18, 18, 0, 1, DateTimeKind.Utc))
        && !ScratchDatabase.StaleXeSession("VariaScratch_20261018120000_0123abcd_xe", new DateTime(2026, 10, 18, 11, 0, 0, DateTimeKind.Utc))
        && !new[] { "VariaScratch_20261018120000_0123abcd", "VariaScratch_20261318120000_0123abcd_xe", "system_health", "VariaScratch_20261018120000_0123abcd_xe2" }.Any(name => ScratchDatabase.StaleXeSession(name, DateTime.MaxValue)),
        "the sweep finds New Login's _lgn database, User Mapping's _lgm, _lgmo and _lgmr, Login Properties' _lpr, the logins it names with _l and a tag of up to 8 lowercase letters or digits, and its Extended Events session once its name's UTC time is old enough, and nothing else (never system_health)");
    {
        // SQL Server on Linux cannot back up to /dev/null (error 3634 in DiskChangeFileSize), so its RESTORING database backs up to one file; Windows keeps NUL.
        const string rs = "VariaScratch_20261018120000_0123abcd_rs";
        var windows = ScratchDatabase.Backup.For(rs, "Windows", @"C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\Backup", 17);
        var linux = ScratchDatabase.Backup.For(rs, "Linux", "/var/opt/mssql/data/", 16);
        static bool Refused(Func<ScratchDatabase.Backup> make)
        {
            try { make(); return false; }
            catch (InvalidOperationException) { return true; }
        }
        Check(windows is { Device: "NUL", IsFile: false } && ScratchDatabase.Backup.For(rs, null, null, 13).Device == "NUL"
            && ScratchDatabase.RestoringSql(windows) == "ALTER DATABASE [" + rs + "] SET RECOVERY FULL;\nBACKUP DATABASE [" + rs + "] TO DISK = N'NUL';\nBACKUP LOG [" + rs + "] TO DISK = N'NUL' WITH NORECOVERY;"
            && linux is { Device: "/var/opt/mssql/data/" + rs + ".bak", IsFile: true } && ScratchDatabase.Backup.For(rs, "Linux", "/var/opt/mssql/backup", 17).Device == "/var/opt/mssql/backup/" + rs + ".bak"
            && ScratchDatabase.RestoringSql(linux) == "ALTER DATABASE [" + rs + "] SET RECOVERY FULL;\nBACKUP DATABASE [" + rs + "] TO DISK = N'/var/opt/mssql/data/" + rs + ".bak';\n"
                + "BACKUP LOG [" + rs + "] TO DISK = N'/var/opt/mssql/data/" + rs + ".bak' WITH NORECOVERY;"
            && linux.DatabaseSql("COPY_ONLY") == "BACKUP DATABASE [" + rs + "] TO DISK = N'/var/opt/mssql/data/" + rs + ".bak' WITH COPY_ONLY;"
            && !ScratchDatabase.RestoringSql(linux).Contains("/dev/null", StringComparison.Ordinal) && !ScratchDatabase.Backup.FactsSql.Contains("/dev/null", StringComparison.Ordinal)
            && ScratchDatabase.Backup.FactsSql.Contains("sys.sp_executesql N'SELECT @platform = host_platform FROM sys.dm_os_host_info;'", StringComparison.Ordinal)
            && ScratchDatabase.Backup.FactsSql.Contains("SERVERPROPERTY('InstanceDefaultBackupPath')", StringComparison.Ordinal)
            && ScratchDatabase.Backup.DeleteSql(linux.Device, 15) == "EXEC master.sys.xp_delete_files N'/var/opt/mssql/data/" + rs + ".bak';"
            && ScratchDatabase.Backup.DeleteSql(linux.Device, 14) == "EXEC master.sys.xp_delete_file 0, N'/var/opt/mssql/data/" + rs + ".bak';"
            && Refused(() => ScratchDatabase.Backup.For("Sales", "Linux", "/var/opt/mssql/data/", 16)) && Refused(() => ScratchDatabase.Backup.For("VariaScratch_20261018120000_0123abcd_tbd.]", "Linux", "/var/opt/mssql/data/", 16))
            && Refused(() => ScratchDatabase.Backup.For(rs, "Linux", null, 16)) && Refused(() => ScratchDatabase.Backup.For(rs, "Linux", @"C:\Backup", 16)),
            "scratch backups go to NUL on Windows and, since SQL Server on Linux cannot write /dev/null, to one file named after the scratch database in its backup folder (full and tail-log backup alike), "
            + "deleted with xp_delete_files from 2019 or xp_delete_file before; only a sweepable scratch name of plain characters names a file, and only in a Linux folder");
        // Restore Database's source backs up to real files on both platforms, which a crashed run's sweep must find again, and nothing else.
        const string rst = "VariaScratch_20261018120000_0123abcd_rst";
        const string winFolder = @"C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\Backup";
        Check(ScratchDatabase.Backup.PartIn(winFolder, rst, "full1.bak") == winFolder + "\\" + rst + "_full1.bak" && ScratchDatabase.Backup.PartIn(winFolder + "\\", rst, "log.trn") == winFolder + "\\" + rst + "_log.trn"
            && ScratchDatabase.Backup.PartIn("/var/opt/mssql/data/", rst, "diff.bak") == "/var/opt/mssql/data/" + rst + "_diff.bak"
            && ScratchDatabase.Backup.Stale(winFolder + "\\" + rst + "_full2.bak", winFolder + "\\", rst) && ScratchDatabase.Backup.Stale("/var/opt/mssql/data/" + rst + "_log3.trn", "/var/opt/mssql/data", rst)
            && ScratchDatabase.Backup.Stale(linux.Device, "/var/opt/mssql/data/", rs)
            && !new[] { winFolder + "\\" + rst + "_full1.mdf", winFolder + "\\" + rst + "_x_y.bak", winFolder + "\\other\\" + rst + "_full1.bak", @"D:\Backup\" + rst + "_full1.bak", winFolder + "\\" + rst + ".bak",
                winFolder + "\\" + rst + "_FULL.bak", winFolder + "\\Sales_full1.bak", winFolder + "\\" + rst + "_full1.bak\\..\\x.bak" }.Any(device => ScratchDatabase.Backup.Stale(device, winFolder, rst))
            && !ScratchDatabase.Backup.Stale(winFolder + "\\Sales_full1.bak", winFolder, "Sales")
            && Refused(() => new(rst, ScratchDatabase.Backup.PartIn("Backup", rst, "full.bak"), 17)) && Refused(() => new("Sales", ScratchDatabase.Backup.PartIn(winFolder, "Sales", "full.bak"), 17))
            && Refused(() => new(rst, ScratchDatabase.Backup.PartIn(winFolder, rst, "../x.bak"), 17)),
            "Restore Database's source backs up to <backup folder><scratch name>_<part>.bak or .trn on either platform, and the stale sweep deletes only such files of a sweepable scratch name in that folder");
    }
    SsisFixtureChecks.Run(Check);
    Check(LiveResultChecks.CancelBound(5000, 1200) == 5000 && LiveResultChecks.CancelBound(5000, 4000) == 8000, "a cancel's time bound keeps its floor and grows with a slower reference");
    QueryResult Stopped(string status, params long[] rowsRead) => new([.. rowsRead.Select((read, index) => new ResultDescriptor(1, index, 1, 1, "rows", [], read, 1, 1, 0, 0, "complete", null, true))],
        0, [], -1, 0, status, null, 0, 1, "master", false, new ResultBudget(0, 0, 0, 0), "");
    Check(LiveResultChecks.StoppedEarly(Stopped("cancelled", 3), 8) && LiveResultChecks.StoppedEarly(Stopped("cancelled", 0), 8) && !LiveResultChecks.StoppedEarly(Stopped("cancelled", 8), 8)
        && !LiveResultChecks.StoppedEarly(Stopped("completed", 3), 8) && !LiveResultChecks.StoppedEarly(Stopped("cancelled"), 8) && !LiveResultChecks.StoppedEarly(Stopped("cancelled", 1, 1), 8),
        "a cancel proves it stopped the script only by leaving rows unread, which a slow reference cannot excuse");
    var measured = new Queue<long>([20_000, 300, 40, 20_000, 16_000, 7]);
    var retried = await LiveResultChecks.OnceMore("a stalled measurement", 15_000, ms => ms, () => Task.FromResult(measured.Dequeue()), _ => { });
    Check(retried == 300 && await LiveResultChecks.OnceMore("a measurement in time", 15_000, ms => ms, () => Task.FromResult(measured.Dequeue()), _ => { }) == 40
        && await LiveResultChecks.OnceMore("a regression", 15_000, ms => ms, () => Task.FromResult(measured.Dequeue()), _ => { }) == 16_000 && measured.Count == 1,
        "a timed live check that misses its bound measures once more, and only once");
    // CI's live jobs split the live suites by their times; a group over budget fails here, before any job is slow.
    var liveNames = LiveGroups.Suites.Select(suite => suite.Name).ToList();
    foreach (var count in new[] { 1, 2, 3, 4 })
    {
        var groups = LiveGroups.Split(LiveGroups.Suites, count);
        Check(groups.Count == count && groups.SelectMany(group => group).Order().SequenceEqual(liveNames.Order()) && groups.All(group => group.SequenceEqual(liveNames.Where(group.Contains)))
            && liveNames.Distinct().Count() == liveNames.Count, "the live groups of " + count + " run every live suite once, each group in run order");
    }
    var ciGroups = LiveGroups.Split(LiveGroups.Suites, LiveGroups.CiGroups).Select(group => group.Sum(name => LiveGroups.Suites.First(suite => suite.Name == name).Seconds)).ToList();
    Check(ciGroups.All(seconds => seconds <= LiveGroups.BudgetSeconds),
        "each of CI's " + LiveGroups.CiGroups + " live groups stays within " + LiveGroups.BudgetSeconds + " s (" + string.Join(", ", ciGroups) + "): speed the slow suite up, or add a group to LiveGroups.CiGroups and ci.yml's live matrix");
    Check(LiveGroups.Parse([]) is null && LiveGroups.Parse(["--live-group", "2/3"]) == new LiveGroups.Group(2, 3)
        && new[] { "0/2", "3/2", "1/0", "x/2", "1/2/3" }.All(value => { try { LiveGroups.Parse(["--live-group", value]); return false; } catch (ArgumentException) { return true; } })
        && LiveGroups.Runs(null, "Query") && LiveGroups.Split([("a", 5), ("b", 5), ("c", 9)], 2) is [["c"], ["a", "b"]]
        && LiveGroups.Parse(["--live-suite", "Scripting"]) is { Suite: "Scripting" } single && LiveGroups.Runs(single, "Scripting") && !LiveGroups.Runs(single, "Query")
        && ((Func<bool>)(() => { try { LiveGroups.Parse(["--live-suite", "NoSuchSuite"]); return false; } catch (ArgumentException) { return true; } }))(),
        "--live-group k/n names one group of n, --live-suite one known suite, and a run without either runs every suite");
    Console.WriteLine("Passed " + passed + " offline .NET checks.");
}

// Microsoft Entra ID needs a tenant: these run only with their own variables, before and without the SQL Server ones.
if (liveGroup is null) await EntraLiveChecks.RunAsync(Check, json);
var server = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SERVER");
if (string.IsNullOrWhiteSpace(server))
{
    if (liveGroup is not null) throw new Exception("--live-group requires VARIA_TEST_SQL_SERVER.");
    Console.WriteLine("Live SQL checks skipped. Set VARIA_TEST_SQL_SERVER to a development SQL Server (Windows authentication), plus VARIA_TEST_SQL_USER and VARIA_TEST_SQL_PASSWORD for SQL authentication; tests use only session-local temporary objects.");
    return;
}
// SQL authentication lets the live checks run against a container on any OS; without a user they keep using Windows authentication.
var sqlUser = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_USER");
var sqlPassword = string.IsNullOrWhiteSpace(sqlUser) ? null
    : Environment.GetEnvironmentVariable("VARIA_TEST_SQL_PASSWORD") ?? throw new Exception("VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.");
ConnectOptions Live(string database) => sqlPassword is null
    ? new(server, database, "windows", null, null, true)
    : new(server, database, "sql", sqlUser, sqlPassword, true);
using var service = new SqlService();
async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
var info = await Call<ConnectionInfo>("connections.connect", Live("master"));
var sessionId = Guid.NewGuid().ToString();
Task<QueryResult> Run(string sql, string? session = null, int timeout = 15, string? query = null, int startLine = 1, int maxRows = 1000, string database = "master", bool stopOnError = false) =>
    Call<QueryResult>("query.execute", new QueryArgs(info.Id, session ?? sessionId, database, sql, query ?? Guid.NewGuid().ToString(), maxRows, timeout, startLine, StopOnError: stopOnError));
// Rows stay in the backend's result store; read them back as the results worker would, from the stored pages.
List<string?[]> RowsOf(ResultDescriptor set) => LiveResultChecks.RowsOf(service.Results, set);
List<string> Texts(QueryResult value) => LiveResultChecks.Texts(value);
// Each live suite reports its time, which LiveGroups.Suites uses to balance CI's live groups.
var reached = new List<string>();
async Task Suite(string name, Func<Task> run)
{
    reached.Add(name);
    if (!LiveGroups.Runs(liveGroup, name)) return;
    var watch = System.Diagnostics.Stopwatch.StartNew();
    await run();
    Console.WriteLine("Live suite " + name + ": " + watch.Elapsed.TotalSeconds.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " s");
}
try
{
    await Suite("Query", async () =>
    {
        QueryResult result;
        var discovered = await Call<List<DatabaseInfo>>("connections.databases", Live("DatabaseThatDoesNotExist"));
        Check(discovered.Any(database => database.Name == "master") && discovered.Any(database => database.Name == "tempdb"), "live database discovery ignores a stale selected database and closes its temporary connection");
        var rejected = new ConnectOptions(server, "master", "sql", "varia_no_such_login_" + Guid.NewGuid().ToString("N")[..8], "never-shown-marker", true);
        foreach (var method in new[] { "connections.connect", "connections.databases" })
        {
            try { await Call<object>(method, rejected); throw new Exception("A login that does not exist was accepted by " + method); }
            catch (RequestException error)
            {
                // Login failed is 18456, class 14; a server that accepts only Windows authentication sometimes closes the pipe
                // before SqlClient reads it, which SqlClient reports as 233, class 20.
                Check(error.Code == "SQL_ERROR" && error.Details is { Number: 18456, Class: 14, State: not null, Server.Length: > 0 } or { Number: 233, Class: 20, State: not null, Server.Length: > 0 } && !error.Message.Contains("never-shown-marker")
                    && !JsonSerializer.Serialize(error.Details).Contains("never-shown-marker"), method + " answers a failed login with its number, state, class and server, and never the password");
            }
        }
        await ConnectionFailureChecks.PoolBlockingAsync(Check, rejected);
        // Development servers (the local one, CI's container) have self-signed certificates: without Trust server certificate,
        // connect and Load databases fail with the reason the Connect dialog offers to fix. A server with a trusted certificate
        // connects instead, and then there is nothing to check.
        var validated = Live("master") with { TrustServerCertificate = false, Encrypt = "mandatory" };
        foreach (var method in new[] { "connections.connect", "connections.databases" })
        {
            try
            {
                var opened = await Call<object>(method, validated);
                if (opened is ConnectionInfo trusted) await Call<object>("connections.disconnect", new ConnectionArgs(trusted.Id));
                Console.WriteLine(method + ": the server's certificate is trusted here, so the untrusted-certificate check is skipped.");
            }
            catch (RequestException error)
            {
                Check(error.Code == "SQL_ERROR" && error.Details is { Reason: ErrorDetailsLimits.Certificate, Class: 20, Server.Length: > 0 },
                    method + " answers an untrusted server certificate with the reason certificate and SqlClient's own message: " + error.Code + " " + error.Details?.Number + " " + error.Message);
            }
        }

        // A Kerberos ticket that expires while connected: every later open says to run kinit, and works again after it.
        var signIn = Guid.NewGuid().ToString();
        var production = service.Open;
        service.Open = ConnectionFailureChecks.ExpiredTicket;
        try
        {
            async Task<string> Refused(Func<Task> call)
            {
                try { await call(); return "accepted"; }
                catch (RequestException error) { return error.Code == "AUTH_KERBEROS" && error.Message == ConnectionFailures.Messages.Expired && error.Details is null ? "kinit" : error.Code + ": " + error.Message; }
            }
            var refusals = new[]
            {
                await Refused(() => Run("SELECT 1;", session: signIn)),
                await Refused(() => Call<List<DatabaseInfo>>("databases.list", new ConnectionArgs(info.Id))),
                await Refused(() => Call<TableColumnsResult>("tables.columns", new TableArgs(info.Id, "master", "sys", "objects")))
            };
            Check(refusals.All(answer => answer == "kinit"), "a query session and database and column lists say to run kinit when the ticket has expired: " + string.Join(", ", refusals));
            var script = await Call<ScriptResult>("scripting.script", new ScriptArgs(info.Id, Guid.NewGuid().ToString(), [new ObjectRefDto("table", "master", "dbo", "VariaNoSuchTable")], "create", ScriptingLiveChecks.Defaults(json)));
            Check(script.Error is { Code: "AUTH_KERBEROS", Retryable: true } && script.Error.Message.EndsWith(ConnectionFailures.Messages.Expired, StringComparison.Ordinal) && script.Text is null,
                "Script As shows an expired ticket's kinit advice as its error value, as Object Explorer does: " + script.Error?.Code);
            var node = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(info.Id, Guid.NewGuid().ToString(), new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "logins")));
            Check(node.Error is { Code: "AUTH_KERBEROS", Retryable: true } && node.Error.Message == ConnectionFailures.Messages.Expired && node.Nodes.Count == 0,
                "Object Explorer shows an expired ticket's kinit advice on the node, which Retry loads again");
        }
        finally { service.Open = production; }
        Check((await Run("SELECT 1;", session: signIn)).Status == "completed", "after kinit, the tab whose session could not sign in opens a new one");

        // A Microsoft Entra sign-in revoked while connected, through the production open (only the open inside it fails, as
        // SqlClient does when the provider recorded that a sign-in is needed): every later open says to connect again, a
        // value where Kerberos's advice is one.
        var entraSession = Guid.NewGuid().ToString();
        var opener = service.OpenConnection;
        service.OpenConnection = (_, _) =>
        {
            var id = Guid.NewGuid();
            service.Entra.Attempts.Record(id, new Varia.Backend.Entra.InteractionRequired(EntraChecks.Request()));
            throw EntraChecks.ProviderFailure(id);
        };
        try
        {
            async Task<string> Expired(Func<Task> call)
            {
                try { await call(); return "accepted"; }
                catch (Exception error) { return error is RequestException { Code: "AUTH_ENTRA", Message: Varia.Backend.Entra.EntraFailures.Messages.SignInExpired, Details: null } ? "connect again" : error.GetType().Name + ": " + error.Message; }
            }
            var answers = new[]
            {
                await Expired(() => Run("SELECT 1;", session: entraSession)),
                await Expired(() => Call<List<DatabaseInfo>>("databases.list", new ConnectionArgs(info.Id))),
                await Expired(() => Call<TableColumnsResult>("tables.columns", new TableArgs(info.Id, "master", "sys", "objects")))
            };
            Check(answers.All(answer => answer == "connect again"), "a query session and database and column lists answer AUTH_ENTRA (connect again) when the Entra sign-in must be repeated: " + string.Join(", ", answers));
            // These answer values; an escaped AUTH_ENTRA becomes a null here, so the check says which.
            async Task<T?> Value<T>(Func<Task<T>> call) where T : class { try { return await call(); } catch (RequestException) { return null; } }
            var script = await Value(() => Call<ScriptResult>("scripting.script", new ScriptArgs(info.Id, Guid.NewGuid().ToString(), [new ObjectRefDto("table", "master", "dbo", "VariaNoSuchTable")], "create", ScriptingLiveChecks.Defaults(json))));
            Check(script?.Error is { Code: "AUTH_ENTRA", Retryable: true } && script.Error.Message.EndsWith(Varia.Backend.Entra.EntraFailures.Messages.SignInExpired, StringComparison.Ordinal) && script.Text is null,
                "Script As shows a revoked Entra sign-in as its retryable error value: " + (script is null ? "an envelope error" : script.Error?.Code));
            var node = await Value(() => Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(info.Id, Guid.NewGuid().ToString(), new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "logins"))));
            Check(node?.Error is { Code: "AUTH_ENTRA", Retryable: true } && node.Error.Message == Varia.Backend.Entra.EntraFailures.Messages.SignInExpired && node.Nodes.Count == 0,
                "Object Explorer shows a revoked Entra sign-in on the node, which Retry loads again: " + (node is null ? "an envelope error" : node.Error?.Code));
            var described = await Value(() => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("table", "master", "dbo", "VariaNoSuchTable"))));
            Check(described?.Error is { Code: "AUTH_ENTRA", Retryable: true } && described.Error.Message == Varia.Backend.Entra.EntraFailures.Messages.SignInExpired && described.DeleteTarget is null,
                "an object action shows a revoked Entra sign-in as its retryable error value: " + (described is null ? "an envelope error" : described.Error?.Code + " " + described.Error?.Message));
        }
        finally { service.OpenConnection = opener; }
        Check((await Run("SELECT 1;", session: entraSession)).Status == "completed", "after connecting again, the tab whose session could not sign in opens a new one");
        var columns = await Call<TableColumnsResult>("tables.columns", new TableArgs(info.Id, "master", "sys", "objects"));
        Check(columns.Columns.Count > 2 && columns.Columns[0] == new ColumnInfo("name", "sysname") && columns.Columns[1] == new ColumnInfo("object_id", "int") && !columns.Truncated, "table columns come in column order with their types");
        try { await Call<TableColumnsResult>("tables.columns", new TableArgs(info.Id, "master", "sys", "objects]")); throw new Exception("A closing bracket matched another table"); }
        catch (RequestException error) { Check(error.Code == "NOT_FOUND", "table columns quote names, so a bracket cannot change which table they read"); }
        result = await Run("SELECT DB_NAME();", timeout: 0);
        Check(result.Status == "completed", "zero timeout allows execution without a deadline");
        result = await Run("SET STATISTICS TIME, IO ON;\nGO\nCREATE TABLE #VariaBatchTest (id int);\nINSERT #VariaBatchTest VALUES (1);\nGO\nINSERT #VariaBatchTest VALUES (2);\nGO 2\nSELECT COUNT(*) AS count FROM #VariaBatchTest;\nGO");
        Check(result.Status == "completed" && result.CompletedBatches == 5, "batches and repeats execute on one session");
        Check(Convert.ToInt32(RowsOf(result.ResultSets.Last())[0][0]) == 3, "temporary table persists across GO");
        Check(Texts(result).Any(value => value.Contains("CPU time", StringComparison.OrdinalIgnoreCase)) && Texts(result).Any(value => value.Contains("logical reads", StringComparison.OrdinalIgnoreCase)), "TIME and IO messages reach output");
        result = await Run("SELECT COUNT(*) FROM #VariaBatchTest;");
        Check(result.Status == "completed" && Texts(result).Any(value => value.Contains("CPU time", StringComparison.OrdinalIgnoreCase)), "SET options and temp tables persist across Execute calls");
        result = await Run("SELECT 'isolated';", Guid.NewGuid().ToString());
        Check(!Texts(result).Any(value => value.Contains("CPU time", StringComparison.OrdinalIgnoreCase)), "statistics settings do not leak to another query tab");
        result = await Run("DECLARE @value int = 1;\nGO\nSELECT @value;\nGO\nPRINT 'runs after the error';", startLine: 20);
        Check(result.Status == "completedWithErrors" && result.Error?.Message.Contains("Line 22") == true, "variables are batch scoped and selected-text line offsets are mapped");
        Check(result.CompletedBatches == 3 && Texts(result).Contains("runs after the error"), "later batches run after a batch's error, as in SSMS");
        result = await Run("DECLARE @value int = 1;\nGO\nSELECT @value;\nGO\nPRINT 'SHOULD_NOT_RUN';", startLine: 20, stopOnError: true);
        Check(result.Status == "failed" && result.CompletedBatches == 1 && !Texts(result).Any(value => value.Contains("SHOULD_NOT_RUN")), "with stopOnError, later batches stop on error");
        result = await Run("SELECT 42 AS retained; PRINT 'before error';\nGO\nTHROW 51000, 'expected failure', 1;\nGO\nPRINT 'SHOULD_NOT_RUN';", stopOnError: true);
        Check(result.Status == "failed" && RowsOf(result.ResultSets[0]).Count == 1 && Texts(result).Contains("before error"), "partial results and messages survive later batch errors");
        result = await Run("SET STATISTICS TIME, IO OFF;\nGO\nSELECT * FROM #VariaBatchTest;");
        Check(result.Status == "completed" && !Texts(result).Any(value => value.Contains("logical reads", StringComparison.OrdinalIgnoreCase)), "statistics OFF applies to subsequent batches");
        result = await Run("SET STATISTICS XML ON;\nGO\nSELECT COUNT(*) AS planned FROM #VariaBatchTest;\nGO\nSET STATISTICS XML OFF;");
        Check(result.Status == "completed" && result.ResultSets.Any(set => set.Kind == "executionPlan" && Convert.ToString(RowsOf(set)[0][0])!.Contains("ShowPlanXML")), "STATISTICS XML preserves raw plan output");
        result = await Run("SET STATISTICS PROFILE ON;\nGO\nSELECT COUNT(*) AS profiled FROM #VariaBatchTest;\nGO\nSET STATISTICS PROFILE OFF;");
        Check(result.Status == "completed" && result.ResultSets.Any(set => set.Columns.Any(column => column.Name == "Rows") && set.Columns.Any(column => column.Name == "Executes")), "STATISTICS PROFILE returns additional result sets");
        result = await Run("SET SHOWPLAN_XML ON;\nGO\nSELECT COUNT(*) AS estimated FROM #VariaBatchTest;\nGO\nSET SHOWPLAN_XML OFF;");
        Check(result.Status == "completed" && result.ResultSets.Count > 0 && result.ResultSets.All(set => set.Kind == "executionPlan"), "estimated showplan batches are passed through unchanged");
        foreach (var mode in new[] { "SHOWPLAN_TEXT", "SHOWPLAN_ALL" })
        {
            result = await Run("SET " + mode + " ON;\nGO\nSELECT COUNT(*) FROM #VariaBatchTest;\nGO\nSET " + mode + " OFF;");
            Check(result.Status == "completed" && result.ResultSets.Count > 0 && result.ResultSets.All(set => set.Kind == "rows"), mode + " preserves estimated plan result sets");
        }
        result = await Run("SELECT 1 AS before_error; SELECT 1/0 AS failed;\nSELECT 2 AS after_error; PRINT 'after statement error';\nGO\nPRINT 'SHOULD_NOT_RUN';", startLine: 5, stopOnError: true);
        Check(result.Status == "failed" && result.ResultSets.Any(set => set.Columns[0].Name == "after_error" && RowsOf(set).Count == 1) && Texts(result).Contains("after statement error"),
            "statement-level errors leave the rest of the batch to SQL Server, as in SSMS");
        Check(result.Error?.Message.Contains("Msg 8134") == true && result.Error.Message.Contains("Line 5") && result.CompletedBatches == 0 && !Texts(result).Contains("SHOULD_NOT_RUN"),
            "a batch with a statement-level error reports its mapped line and stops later batches");
        result = await Run("SELECT hierarchyid::GetRoot() AS h, geography::Point(1, 2, 4326) AS g, CAST(NULL AS hierarchyid) AS n, CAST(12345678901234567890123456789012345678 AS decimal(38,0)) AS d;");
        Check(result.Status == "completed" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "0x" && Convert.ToString(RowsOf(result.ResultSets[0])[0][1])!.StartsWith("0xE6100000")
            && RowsOf(result.ResultSets[0])[0][2] is null && Convert.ToString(RowsOf(result.ResultSets[0])[0][3]) == "12345678901234567890123456789012345678",
            "CLR UDT values and decimals beyond System.Decimal are displayed instead of failing the script");
        result = await Run("DECLARE @i int = 0; WHILE @i < 50 BEGIN SELECT 1/0; SET @i += 1; END");
        Check(result.Status == "completedWithErrors" && result.Error?.Message.Contains("and 30 more errors") == true, "errors repeated by a running batch are counted, not accumulated");
        result = await Run("SELECT id, 10 / (id - 5) AS v FROM (VALUES (1), (2), (3), (4), (5), (6)) AS t(id);");
        Check(result.Status == "completedWithErrors" && result.ResultSets[0].Incomplete && RowsOf(result.ResultSets[0]).Count < 6, "a result set cut short by a statement error is marked incomplete");
        // When SqlClient's CommandTimeout and the script's token expired on the same timer tick, SqlClient could leave the
        // session one response behind: the next execution in that tab returned nothing and each later one the previous one's
        // results. The race needs the deadline to land in NextResultAsync, and it is likeliest while the timeout paths are
        // still cold, so this runs before any other timeout and in many tabs at once (2 to 6 of 24 fell behind without the fix).
        var inStep = await Task.WhenAll(Enumerable.Range(0, 24).Select(async index =>
        {
            var tab = Guid.NewGuid().ToString();
            try
            {
                // The session opens first, so the script's deadline and the command's start are as close as they can be.
                await Run("SELECT 0;", tab);
                var timedOut = await Run("SELECT 1/0; RAISERROR ('flush', 0, 1) WITH NOWAIT;\nWAITFOR DELAY '00:00:05';", tab, timeout: 1);
                var probes = new List<string?>();
                for (var probe = 1; probe <= 2; probe++)
                {
                    var answer = await Run("SELECT 'tab " + index + " probe " + probe + "';", tab);
                    probes.Add(answer.Status == "completed" && answer.ResultSets.Count == 1 ? RowsOf(answer.ResultSets[0]).SingleOrDefault()?[0] : answer.Status);
                }
                return timedOut.Status == "timedOut" && probes.SequenceEqual(["tab " + index + " probe 1", "tab " + index + " probe 2"]) ? null : timedOut.Status + ": " + string.Join(", ", probes);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(tab)); }
        }));
        Check(inStep.All(failure => failure is null), "a script timeout leaves its tab's session in step with its requests: " + string.Join(" | ", inStep.Where(failure => failure is not null)));
        // RAISERROR WITH NOWAIT flushes the buffered error to the client before the batch waits.
        result = await Run("SELECT 1/0; RAISERROR ('flush', 0, 1) WITH NOWAIT;\nWAITFOR DELAY '00:00:05';", timeout: 1);
        Check(result.Status == "timedOut" && result.Error?.Message.Contains("Msg 8134") == true, "errors raised before a timeout are still reported");
        // Now and then SqlClient ends a cancelled batch's reader as if the batch had finished, raising nothing (1 of 24 tabs above
        // reported completedWithErrors after 1 s of its WAITFOR). Cancelling just as the reader ends stands in for it.
        {
            var tab = Guid.NewGuid().ToString();
            var stoppedId = Guid.NewGuid().ToString();
            service.ReaderEnded = () => Call<object>("query.cancel", new CancelArgs(stoppedId)).GetAwaiter().GetResult();
            try { result = await Run("SELECT 1/0; RAISERROR ('flush', 0, 1) WITH NOWAIT;", tab, query: stoppedId); }
            finally { service.ReaderEnded = null; }
            var probe = await Run("SELECT 'in step';", tab);
            await Call<object>("query.session.close", new SessionArgs(tab));
            Check(result.Status == "cancelled" && result.Error?.Code == "CANCELLED" && result.CompletedBatches == 0 && result.Error.Message.Contains("Msg 8134")
                && probe.Status == "completed" && RowsOf(probe.ResultSets[0]).SingleOrDefault()?[0] == "in step",
                "a batch whose token fired before its reader ended is reported stopped, not finished, and its session stays in step: " + result.Status + " " + result.CompletedBatches);
        }
        result = await Run("SELECT 1;", database: "VariaDatabaseThatDoesNotExist");
        Check(result.Status == "failed" && result.Error?.Message.Contains("Msg 911") == true && result.Error.BatchNumber == 0, "a missing target database fails before any batch runs");
        result = await Run("SELECT DB_NAME();");
        Check(result.Status == "completed" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "master", "the session recovers after a failed database change");
        result = await Run("SELECT 1 AS a;\nGO\nSELECT * FROM dbo.VariaTableThatDoesNotExist;");
        Check(result.Status == "completedWithErrors" && result.CompletedBatches == 2 && result.ResultSets.Count == 1 && result.Error?.Message.Contains("Msg 208") == true, "compile errors in later batches keep earlier output");
        result = await Run("RAISERROR ('expected informational message', 10, 1); PRINT 'expected print';");
        Check(result.Status == "completed" && result.Messages.Where(entry => entry.Text is "expected informational message" or "expected print").Count(entry => entry.Kind == "print") == 2,
            "low severity informational messages do not become errors and are marked as printed by the script (print)");
        // An aggregate over a NULL warns (8153, severity 10) under the default ANSI_WARNINGS: SQL Server's own message, which must not open the strip.
        result = await Run("SELECT SUM(x) AS total FROM (VALUES (1), (NULL)) AS v(x);");
        Check(result.Status == "completed" && result.Messages.Any(entry => entry.Kind == "server" && entry.Text.StartsWith("Warning: Null value is eliminated")) && result.Messages.All(entry => entry.Kind != "print"),
            "SQL Server's own warnings (8153) are server messages, not print: " + string.Join(" | ", result.Messages.Select(entry => entry.Kind + ":" + entry.Text)));
        result = await Run("USE tempdb;\nGO\nSELECT DB_NAME();");
        Check(result.Status == "completed" && result.Database == "tempdb" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "tempdb", "USE persists across batches and returns the new database context");
        result = await Run("SELECT DB_NAME();", database: result.Database);
        Check(result.Database == "tempdb" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "tempdb", "returned database context persists across Execute calls");
        result = await Run("USE master; THROW 51000, 'expected context failure', 1;", database: "tempdb");
        Check(result.Status == "completedWithErrors" && result.Database == "master", "database context is retained even when a later statement fails");
        result = await Run("BEGIN TRANSACTION; INSERT #VariaBatchTest VALUES (9);\nGO\nSELECT @@TRANCOUNT AS openTransactions, COUNT(*) AS count FROM #VariaBatchTest;");
        Check(result.Status == "completed" && Convert.ToInt32(RowsOf(result.ResultSets[0])[0][0]) == 1 && Convert.ToInt32(RowsOf(result.ResultSets[0])[0][1]) == 4, "GO does not commit an explicit transaction");
        result = await Run("SELECT @@TRANCOUNT; ROLLBACK; SELECT COUNT(*) FROM #VariaBatchTest;");
        Check(result.Status == "completed" && Convert.ToInt32(RowsOf(result.ResultSets[0])[0][0]) == 1 && Convert.ToInt32(RowsOf(result.ResultSets[1])[0][0]) == 3, "transactions persist between Execute calls until explicitly ended");
        var lockSession = Guid.NewGuid().ToString();
        var lockName = "VariaLockTest-" + lockSession;
        result = await Run($"BEGIN TRANSACTION; EXEC sp_getapplock @Resource = '{lockName}', @LockMode = 'Exclusive', @LockOwner = 'Transaction';", lockSession);
        Check(result.Status == "completed", "a tab can hold a transaction-owned lock");
        await Call<object>("query.session.close", new SessionArgs(lockSession));
        // The probe opens in tempdb so it cannot reuse a pooled session connection, then locks in master.
        result = await Run($"USE master; BEGIN TRANSACTION; DECLARE @granted int; EXEC @granted = sp_getapplock @Resource = '{lockName}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 3000; SELECT @granted; ROLLBACK;", Guid.NewGuid().ToString(), database: "tempdb");
        Check(result.Status == "completed" && Convert.ToInt32(RowsOf(result.ResultSets[0])[0][0]) >= 0, "closing a tab rolls back its open transaction and releases its locks");
        try { await Run("INSERT #VariaBatchTest VALUES (9);\nGO\nSELECT 1;\nGO 0"); throw new Exception("Invalid script executed"); }
        catch (RequestException error) { Check(error.Code == "INVALID_SCRIPT", "invalid GO fails preflight"); }
        result = await Run("SELECT COUNT(*) FROM #VariaBatchTest;");
        Check(result.Status == "completed" && Convert.ToInt32(RowsOf(result.ResultSets[0])[0][0]) == 3, "invalid GO executes none of the earlier batches");
        var slowId = Guid.NewGuid().ToString();
        var slow = Run("SELECT 7 AS retained;\nGO\nWAITFOR DELAY '00:00:10';\nGO\nPRINT 'SHOULD_NOT_RUN';", query: slowId);
        await Task.Delay(400);
        try { await Run("SELECT 1;"); throw new Exception("Concurrent query accepted"); }
        catch (RequestException error) { Check(error.Code == "SESSION_BUSY", "a tab cannot run overlapping scripts"); }
        await Call<object>("query.cancel", new CancelArgs(slowId));
        result = await slow;
        Check(result.Status == "cancelled" && result.CompletedBatches == 1 && result.ResultSets.Count == 1, "cancel retains output and skips remaining batches");
        result = await Run("WAITFOR DELAY '00:00:00.700';\nGO\nWAITFOR DELAY '00:00:00.700';\nGO\nPRINT 'SHOULD_NOT_RUN';", timeout: 1);
        Check(result.Status == "timedOut" && result.CompletedBatches == 1, "one deadline covers the entire script");
        result = await Run("SELECT TOP (10) object_id FROM sys.all_objects;\nGO 2\nPRINT 'after display cap';", maxRows: 2);
        Check(result.Status == "completed" && result.ResultSets.Sum(set => RowsOf(set).Count) == 2 && Texts(result).Contains("after display cap"), "display limits do not skip later SQL");
        await Call<object>("query.session.close", new SessionArgs(sessionId));
        result = await Run("SELECT * FROM #VariaBatchTest;");
        Check(result.Status == "completedWithErrors" && result.Error?.Message.Contains("Msg 208") == true, "closing a tab removes temporary objects and session state");
    });
    await Suite("Live", () => LiveChecks.LiveAsync(Check, service, info, Live("tempdb"), json));
    await Suite("LiveData", () => LiveDataChecks.RunAsync(Check, service, info, Live, json));
    await Suite("LiveTableData", () => LiveTableDataChecks.RunAsync(Check, service, Live, json));
    await Suite("ExplorerStatus", () => ExplorerStatusLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Execution", () => ExecutionLiveChecks.RunAsync(Check, service, info, json));
    await Suite("EstimatedPlans", async () =>
    {
        await EstimatedPlanChecks.RunAsync(Check, service, info, json);
        await SessionEstimatedPlanChecks.RunAsync(Check, service, info, json);
    });
    await Suite("Transaction", () => TransactionLiveChecks.RunAsync(Check, service, info, json));
    await Suite("LiveResult", () => LiveResultChecks.RunAsync(Check, service, info, Live("master"), json));
    await Suite("ClientStatistics", () => ClientStatisticsChecks.RunAsync(Check, service, info, json));
    await Suite("CellLength", () => CellLengthLiveChecks.RunAsync(Check, service, info, json));
    await Suite("Explorer", () => ExplorerLiveChecks.RunAsync(Check, service, info, Live, sqlUser, json));
    await Suite("Scripting", () => ScriptingLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("ScriptingInjection", () => ScriptingLiveChecks.InjectionMatrixAsync(Check, service, info, Live, json));
    await Suite("Action", () => ActionLiveChecks.RunAsync(Check, service, info, Live("master"), json));
    await Suite("ServerFiles", () => ServerFilesLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Seam", () => SeamLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("DatabaseState", () => DatabaseStateLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("RenameDatabase", () => RenameDatabaseLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Detach", () => DetachLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("ActionProgress", () => ActionProgressLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Attach", () => AttachLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Restore", () => RestoreLiveChecks.RunAsync(Check, service, info, json));
    await Suite("Login", () => LoginLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("LoginListing", () => LoginListingLiveChecks.RunAsync(Check, service, info, json));
    await Suite("LoginAction", () => LoginActionLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("LoginDelete", () => LoginDeleteLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Unlock", () => UnlockLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("LoginProperties", () => LoginPropertiesLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Securables", () => SecurablesLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("LoginKinds", () => LoginKindsLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("DatabaseProperties", () => DatabasePropertiesLiveChecks.RunAsync(Check, service, info, json));
    await Suite("Designer", () => DesignerLiveChecks.RunAsync(Check, service, info, Live("master"), json));
    await Suite("NewDatabase", () => NewDatabaseLiveChecks.RunAsync(Check, service, info, json));
    await Suite("Ssis", () => SsisLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Activity", () => ActivityLiveChecks.RunAsync(Check, service, info));
    await Suite("ActivitySource", () => ActivitySourceLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("ActivityAction", () => ActivityActionLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("SsisCreate", () => SsisCreateLiveChecks.RunAsync(Check, service, info, Live, json));
    await Suite("Entra", () => EntraChecks.LiveAsync(Check, Live("master"), json));
    Check(LiveGroups.Covers(reached), "the live suites are LiveGroups.Suites, in order: " + string.Join(", ", reached));
    Console.WriteLine(liveGroup is null
        ? "Passed " + passed + " total .NET checks including live SQL batches, statistics variants, isolation, failure, cancellation, timeout, and cleanup."
        : "Passed " + passed + " live .NET checks of " + (liveGroup.Suite is { } only ? "the suite " + only : "group " + liveGroup.Index + "/" + liveGroup.Count) + ".");
}
finally { await Call<object>("connections.disconnect", new ConnectionArgs(info.Id)); }

using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Tests;

var passed = 0;
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    passed++;
}
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
try { ConnectionSettings.Build(settings with { Advanced = new(PacketSize: 1) }); throw new Exception("Invalid packet size accepted"); }
catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "backend rejects invalid advanced ranges"); }
try { ConnectionSettings.Build(settings with { Advanced = new(ColumnEncryption: true, SecureEnclaves: true, AttestationProtocol: "HGS") }); throw new Exception("Missing attestation URL accepted"); }
catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "HGS requires an attestation URL"); }
ProtocolChecks.Run(Check);
PageChecks.Run(Check);
HostChecks.Run(Check);
StoreChecks.Run(Check);
await TextChecks.RunAsync(Check);
await ExplorerChecks.RunAsync(Check);
await ScriptingChecks.RunAsync(Check);
using (var offline = new SqlService())
{
    try { await offline.DispatchAsync("tables.columns", JsonSerializer.SerializeToElement(new TableArgs(Guid.NewGuid().ToString(), "master", "dbo", new string('x', 129)), json), json); throw new Exception("Overlong table name accepted"); }
    catch (RequestException error) { Check(error.Code == "INVALID_PARAMS", "table columns reject an overlong name before looking up the connection"); }
}
Console.WriteLine("Passed " + passed + " offline .NET checks.");

var server = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SERVER");
if (string.IsNullOrWhiteSpace(server))
{
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
Task<QueryResult> Run(string sql, string? session = null, int timeout = 15, string? query = null, int startLine = 1, int maxRows = 1000, string database = "master") =>
    Call<QueryResult>("query.execute", new QueryArgs(info.Id, session ?? sessionId, database, sql, query ?? Guid.NewGuid().ToString(), maxRows, timeout, startLine));
// Rows stay in the backend's result store; read them back as the results worker would, from the stored pages.
List<string?[]> RowsOf(ResultDescriptor set) => LiveResultChecks.RowsOf(service.Results, set);
List<string> Texts(QueryResult value) => LiveResultChecks.Texts(value);
QueryResult result;
try
{
    var discovered = await Call<List<DatabaseInfo>>("connections.databases", Live("DatabaseThatDoesNotExist"));
    Check(discovered.Any(database => database.Name == "master") && discovered.Any(database => database.Name == "tempdb"), "live database discovery ignores a stale selected database and closes its temporary connection");
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
    result = await Run("DECLARE @value int = 1;\nGO\nSELECT @value;\nGO\nPRINT 'SHOULD_NOT_RUN';", startLine: 20);
    Check(result.Status == "failed" && result.Error?.Message.Contains("Line 22") == true, "variables are batch scoped and selected-text line offsets are mapped");
    Check(result.CompletedBatches == 1 && !Texts(result).Any(value => value.Contains("SHOULD_NOT_RUN")), "later batches stop on error");
    result = await Run("SELECT 42 AS retained; PRINT 'before error';\nGO\nTHROW 51000, 'expected failure', 1;\nGO\nPRINT 'SHOULD_NOT_RUN';");
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
    result = await Run("SELECT 1 AS before_error; SELECT 1/0 AS failed;\nSELECT 2 AS after_error; PRINT 'after statement error';\nGO\nPRINT 'SHOULD_NOT_RUN';", startLine: 5);
    Check(result.Status == "failed" && result.ResultSets.Any(set => set.Columns[0].Name == "after_error" && RowsOf(set).Count == 1) && Texts(result).Contains("after statement error"),
        "statement-level errors leave the rest of the batch to SQL Server, as in SSMS");
    Check(result.Error?.Message.Contains("Msg 8134") == true && result.Error.Message.Contains("Line 5") && result.CompletedBatches == 0 && !Texts(result).Contains("SHOULD_NOT_RUN"),
        "a batch with a statement-level error reports its mapped line and stops later batches");
    result = await Run("SELECT hierarchyid::GetRoot() AS h, geography::Point(1, 2, 4326) AS g, CAST(NULL AS hierarchyid) AS n, CAST(12345678901234567890123456789012345678 AS decimal(38,0)) AS d;");
    Check(result.Status == "completed" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "0x" && Convert.ToString(RowsOf(result.ResultSets[0])[0][1])!.StartsWith("0xE6100000")
        && RowsOf(result.ResultSets[0])[0][2] is null && Convert.ToString(RowsOf(result.ResultSets[0])[0][3]) == "12345678901234567890123456789012345678",
        "CLR UDT values and decimals beyond System.Decimal are displayed instead of failing the script");
    result = await Run("DECLARE @i int = 0; WHILE @i < 50 BEGIN SELECT 1/0; SET @i += 1; END");
    Check(result.Status == "failed" && result.Error?.Message.Contains("and 30 more errors") == true, "errors repeated by a running batch are counted, not accumulated");
    result = await Run("SELECT id, 10 / (id - 5) AS v FROM (VALUES (1), (2), (3), (4), (5), (6)) AS t(id);");
    Check(result.Status == "failed" && result.ResultSets[0].Incomplete && RowsOf(result.ResultSets[0]).Count < 6, "a result set cut short by a statement error is marked incomplete");
    // RAISERROR WITH NOWAIT flushes the buffered error to the client before the batch waits.
    result = await Run("SELECT 1/0; RAISERROR ('flush', 0, 1) WITH NOWAIT;\nWAITFOR DELAY '00:00:05';", timeout: 1);
    Check(result.Status == "timedOut" && result.Error?.Message.Contains("Msg 8134") == true, "errors raised before a timeout are still reported");
    result = await Run("SELECT 1;", database: "VariaDatabaseThatDoesNotExist");
    Check(result.Status == "failed" && result.Error?.Message.Contains("Msg 911") == true, "a missing target database fails before any batch runs");
    result = await Run("SELECT DB_NAME();");
    Check(result.Status == "completed" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "master", "the session recovers after a failed database change");
    result = await Run("SELECT 1 AS a;\nGO\nSELECT * FROM dbo.VariaTableThatDoesNotExist;");
    Check(result.Status == "failed" && result.ResultSets.Count == 1 && result.Error?.Message.Contains("Msg 208") == true, "compile errors in later batches keep earlier output");
    result = await Run("RAISERROR ('expected informational message', 10, 1); PRINT 'expected print';");
    Check(result.Status == "completed" && Texts(result).Contains("expected informational message") && Texts(result).Contains("expected print"), "low severity informational messages do not become errors");
    result = await Run("USE tempdb;\nGO\nSELECT DB_NAME();");
    Check(result.Status == "completed" && result.Database == "tempdb" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "tempdb", "USE persists across batches and returns the new database context");
    result = await Run("SELECT DB_NAME();", database: result.Database);
    Check(result.Database == "tempdb" && Convert.ToString(RowsOf(result.ResultSets[0])[0][0]) == "tempdb", "returned database context persists across Execute calls");
    result = await Run("USE master; THROW 51000, 'expected context failure', 1;", database: "tempdb");
    Check(result.Status == "failed" && result.Database == "master", "database context is retained even when a later statement fails");
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
    Check(result.Status == "failed", "closing a tab removes temporary objects and session state");
    await LiveResultChecks.RunAsync(Check, service, info, Live("master"), json);
    await ExplorerLiveChecks.RunAsync(Check, service, info, Live, sqlUser, json);
    await ScriptingLiveChecks.RunAsync(Check, service, info, Live, json);
    Console.WriteLine("Passed " + passed + " total .NET checks including live SQL batches, statistics variants, isolation, failure, cancellation, timeout, and cleanup.");
}
finally { await Call<object>("connections.disconnect", new ConnectionArgs(info.Id)); }

using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Results;

namespace Varia.Backend.MultiQuery;

internal sealed record TransactionScriptViolation(int Line, int Column, string StatementKind, string Message);

internal sealed record TransactionProbeResult(bool Valid, short XactState = 0, int TranCount = 0, long? TransactionId = null, string? FailureReason = null);

/// <summary>SQL Server multi-target runner: pre-flight validation (duplicate physical server detection, single-parse-thread
/// ScriptDom Msg 226/574 + COMMIT/ROLLBACK checks), ephemeral unpooled Phase 1 execution with post-batch transaction probes,
/// and Phase 2 Commit/Rollback handle.</summary>
internal sealed class SqlServerMultiRunner(SqlService service, Func<string, string?>? serverOf = null) : IMultiTargetRunner
{
    /// <summary>Maximum active ephemeral SQL Server connections across all concurrent multi-server runs.</summary>
    internal const int MaxEphemeralConnections = 64;
    internal const int RollbackTimeoutSeconds = 10;

    internal const string BeginTransactionWithIdSql = "SET XACT_ABORT ON; BEGIN TRANSACTION; SELECT CURRENT_TRANSACTION_ID();";
    internal const string BeginTransactionLegacySql = "SET XACT_ABORT ON; BEGIN TRANSACTION; SELECT @@TRANCOUNT;";
    internal const string ProbeTransactionWithIdSql = "SELECT XACT_STATE(), @@TRANCOUNT, CURRENT_TRANSACTION_ID();";
    internal const string ProbeTransactionLegacySql = "SELECT XACT_STATE(), @@TRANCOUNT;";
    internal const string RollbackTransactionSql = "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;";

    private static readonly Regex InvalidScriptLine = new(@"^Line (\d+):", RegexOptions.CultureInvariant);

    private readonly Func<string, string?> resolveServer = serverOf ?? service.ServerOf;
    private readonly object ephemeralGate = new();
    private int activeEphemeralConnections;

    public string Provider => Providers.SqlServer;

    internal int ActiveEphemeralConnections
    {
        get { lock (ephemeralGate) return activeEphemeralConnections; }
    }

    /// <summary>CURRENT_TRANSACTION_ID() exists on SQL Server 2016+ (Major >= 13) and Azure SQL Database / Managed Instance
    /// (EngineEdition 5 or 8, which report ProductMajorVersion == 12).</summary>
    internal static bool SupportsCurrentTransactionId(ServerProfile profile) =>
        profile.Major >= 13 || profile.EngineEdition is 5 or 8;

    /// <summary>Validates probe column count and CLR types BEFORE reading values so SET SHOWPLAN_XML/TEXT/ALL ON
    /// (which returns 1 string column) cleanly aborts without throwing InvalidCastException.</summary>
    internal static bool ValidateTransactionProbeSchema(DbDataReader reader, bool expectTransactionId)
    {
        var expectedColumns = expectTransactionId ? 3 : 2;
        if (reader.FieldCount != expectedColumns) return false;
        if (reader.GetFieldType(0) != typeof(short)) return false;
        if (reader.GetFieldType(1) != typeof(int)) return false;
        if (expectTransactionId && reader.GetFieldType(2) != typeof(long)) return false;
        return true;
    }

    internal static async Task<TransactionProbeResult> ReadTransactionProbeAsync(DbDataReader reader, bool expectTransactionId, CancellationToken token)
    {
        if (!await reader.ReadAsync(token).ConfigureAwait(false))
            return new TransactionProbeResult(false, FailureReason: "The coordinated transaction state could not be verified (SET NOEXEC, PARSEONLY, FMTONLY, or SHOWPLAN may be active).");
        if (!ValidateTransactionProbeSchema(reader, expectTransactionId))
            return new TransactionProbeResult(false, FailureReason: "The coordinated transaction probe returned an unexpected schema (SET SHOWPLAN_XML, SHOWPLAN_TEXT, or SHOWPLAN_ALL may be active).");
        if (reader.IsDBNull(0) || reader.IsDBNull(1) || (expectTransactionId && reader.IsDBNull(2)))
            return new TransactionProbeResult(false, FailureReason: "The coordinated transaction probe returned NULL values.");
        var xactState = reader.GetInt16(0);
        var tranCount = reader.GetInt32(1);
        long? txId = expectTransactionId ? reader.GetInt64(2) : null;
        return new TransactionProbeResult(true, xactState, tranCount, txId);
    }

    internal static async Task<long?> ReadScalarInt64Async(DbDataReader reader, CancellationToken token)
    {
        if (!await reader.ReadAsync(token).ConfigureAwait(false)) return null;
        if (reader.FieldCount != 1 || reader.GetFieldType(0) != typeof(long) || reader.IsDBNull(0)) return null;
        return reader.GetInt64(0);
    }

    internal static async Task<int?> ReadScalarInt32Async(DbDataReader reader, CancellationToken token)
    {
        if (!await reader.ReadAsync(token).ConfigureAwait(false)) return null;
        if (reader.FieldCount != 1 || reader.GetFieldType(0) != typeof(int) || reader.IsDBNull(0)) return null;
        return reader.GetInt32(0);
    }

    public async Task<IReadOnlyList<MultiTargetPreflightOutcome>> PreflightAsync(IReadOnlyList<MultiTargetContext> targets, CancellationToken token)
    {
        if (targets.Count == 0) return [];

        var first = targets[0];
        var baseLine = Math.Max(1, first.StartLine);
        var baseCol = Math.Max(1, first.StartColumn);

        if (first.Mode != "transaction")
        {
            try
            {
                _ = SqlScript.Parse(first.Sql, baseLine);
            }
            catch (RequestException error)
            {
                var line = ExtractLine(error.Message, baseLine);
                var targetError = new MultiTargetError(error.Code, error.Message, Line: line);
                return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: false, Error: targetError))];
            }
            return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: true))];
        }

        // Transaction mode pre-flight:
        // 1. Reject duplicate physical servers (prevents undetectable client-side self-deadlock).
        var duplicateErrors = new Dictionary<string, MultiTargetError>(StringComparer.Ordinal);
        var seenServers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var target in targets)
        {
            var server = resolveServer(target.Target.ConnectionId);
            if (string.IsNullOrWhiteSpace(server)) continue;
            if (!seenServers.TryAdd(server, target.Target.TargetKey))
            {
                duplicateErrors[target.Target.TargetKey] = new MultiTargetError(
                    "INVALID_PARAMS",
                    "Coordinated Transaction mode cannot target multiple connections to the same SQL Server instance because independent sessions can self-deadlock.");
            }
        }

        if (duplicateErrors.Count > 0)
        {
            return [.. targets.Select(t => duplicateErrors.TryGetValue(t.Target.TargetKey, out var err)
                ? new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: false, Error: err)
                : new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: true))];
        }

        // 2. Parse ALL batches in ONE ResultNames.OnParseThreadAsync call and reject COMMIT/ROLLBACK and Msg 226/574 statements.
        var violations = await ValidateTransactionScriptAsync(first.Sql, baseLine, baseCol, token).ConfigureAwait(false);
        if (violations.Count > 0)
        {
            var primary = violations[0];
            var targetError = new MultiTargetError("INVALID_SCRIPT", primary.Message, Line: primary.Line);
            return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: false, Error: targetError))];
        }

        return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: true))];
    }

    /// <summary>Parses all batches in one <see cref="ResultNames.OnParseThreadAsync{T}"/> call, failing closed on
    /// MaxParseChars, MaxParenDepth, syntax errors, explicit COMMIT/ROLLBACK (without savepoint), and Msg 226/574
    /// non-transactional statements.</summary>
    internal static async Task<IReadOnlyList<TransactionScriptViolation>> ValidateTransactionScriptAsync(
        string sql, int startLine, int startColumn, CancellationToken token)
    {
        var baseLine = Math.Max(1, startLine);
        var baseCol = Math.Max(1, startColumn);

        List<SqlBatch> batches;
        try
        {
            batches = SqlScript.Parse(sql, baseLine);
        }
        catch (RequestException error)
        {
            var line = ExtractLine(error.Message, baseLine);
            return [new TransactionScriptViolation(line, line == baseLine ? baseCol : 1, "SCRIPT", error.Message)];
        }

        if (batches.Count == 0) return [];

        token.ThrowIfCancellationRequested();

        return await ResultNames.OnParseThreadAsync(() => ValidateTransactionBatches(batches, baseLine, baseCol, token))
            .WaitAsync(token)
            .ConfigureAwait(false);
    }

    private static IReadOnlyList<TransactionScriptViolation> ValidateTransactionBatches(
        IReadOnlyList<SqlBatch> batches, int startLine, int startColumn, CancellationToken token)
    {
        var violations = new List<TransactionScriptViolation>();
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);

        foreach (var batch in batches)
        {
            token.ThrowIfCancellationRequested();
            var firstLine = startLine + batch.StartLine - 1;
            var batchCol = batch.StartLine == 1 ? startColumn : 1;

            if (batch.Sql.Length > ResultNames.MaxParseChars)
            {
                violations.Add(new TransactionScriptViolation(
                    firstLine, batchCol, "BATCH_TOO_LARGE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch exceeds the {ResultNames.MaxParseChars.ToString("N0", CultureInfo.InvariantCulture)}-character pre-flight parse limit for Coordinated Transaction mode."));
                continue;
            }

            if (batch.ParenDepth > ResultNames.MaxParenDepth)
            {
                violations.Add(new TransactionScriptViolation(
                    firstLine, batchCol, "NESTING_DEPTH",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch exceeds the maximum parenthesis nesting depth ({ResultNames.MaxParenDepth.ToString(CultureInfo.InvariantCulture)}) for Coordinated Transaction pre-flight validation."));
                continue;
            }

            TSqlFragment? fragment;
            IList<ParseError> errors;
            try
            {
                using var reader = new StringReader(batch.Sql);
                fragment = parser.Parse(reader, out errors);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                violations.Add(new TransactionScriptViolation(
                    firstLine, batchCol, "PARSE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch could not be parsed for Coordinated Transaction pre-flight validation."));
                continue;
            }

            if (errors.Count > 0)
            {
                foreach (var error in errors)
                {
                    var line = firstLine + Math.Max(1, error.Line) - 1;
                    var col = ColumnOf(batch.StartLine, error.Line, error.Column, startColumn);
                    violations.Add(new TransactionScriptViolation(line, col, "SYNTAX", error.Message));
                }
                continue;
            }

            if (fragment is not TSqlScript script)
            {
                violations.Add(new TransactionScriptViolation(
                    firstLine, batchCol, "PARSE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch did not parse as a T-SQL script."));
                continue;
            }

            var visitor = new TransactionPreflightVisitor(firstLine, batch.StartLine, startColumn, violations);
            script.Accept(visitor);
        }

        return violations;
    }

    private static int ColumnOf(int batchStartLine, int fragmentLine, int fragmentColumn, int scriptStartColumn)
    {
        var col = Math.Max(1, fragmentColumn);
        return batchStartLine == 1 && fragmentLine <= 1 ? Math.Max(1, scriptStartColumn) + col - 1 : col;
    }

    private static int ExtractLine(string message, int fallback)
    {
        var match = InvalidScriptLine.Match(message);
        return match.Success && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : fallback;
    }

    private void AcquireEphemeralConnectionSlot()
    {
        lock (ephemeralGate)
        {
            if (activeEphemeralConnections >= MaxEphemeralConnections)
                throw new RequestException("SESSION_LIMIT",
                    $"This multi-server query was not executed: {MaxEphemeralConnections.ToString("N0", CultureInfo.InvariantCulture)} ephemeral SQL Server connections are already active.");
            if (service.OpenSessionCount + activeEphemeralConnections >= service.SessionLimit)
                throw new RequestException("SESSION_LIMIT",
                    "This query was not executed: " + service.SessionLimit.ToString("N0", CultureInfo.InvariantCulture)
                    + " SQL sessions are already open, the most Varia SQL Manager keeps open.");
            activeEphemeralConnections++;
        }
    }

    private void ReleaseEphemeralConnectionSlot()
    {
        lock (ephemeralGate)
        {
            if (activeEphemeralConnections > 0) activeEphemeralConnections--;
        }
    }

    public async Task<MultiTargetPhase1Outcome> ExecutePhase1Async(MultiTargetContext target, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var startLine = Math.Max(1, target.StartLine);
        var isTransaction = target.Mode == "transaction";
        var targetKey = target.Target.TargetKey;
        var dialect = target.Provider;

        var unbatched = new List<ResultMarker>();
        List<SqlBatch> batches;
        try
        {
            batches = SqlScript.Parse(target.Sql, startLine, unbatched);
        }
        catch (RequestException error)
        {
            var errLine = ExtractLine(error.Message, startLine);
            target.Messages.Add(error.Message, MessageKind.Error, errLine, targetKey, dialect);
            var err = new MultiTargetError(error.Code, error.Message, Line: errLine);
            EmitTerminalState(target, "failed", 0, 0, 0, 0, watch.ElapsedMilliseconds, err);
            return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                BuildOutcome(target, "failed", 0, 0, 0, watch.ElapsedMilliseconds, [], null, null, err),
                [], NeedsCommit: false));
        }

        var totalBatches = batches.Sum(batch => batch.RepeatCount);
        var nameNotes = new ResultNameNotes(text => target.Messages.Add(text, MessageKind.Info, targetKey: targetKey, dialect: dialect));
        var namePlans = new ResultNamePlan?[batches.Count];
        ResultNameBinder? pendingNames = null;
        var plannedBatches = 0;
        var pendingRepetition = 0;
        var nextRepetition = 1;
        var namesBegun = false;
        Action<string> warn = text => target.Messages.Add(text, MessageKind.Info, targetKey: targetKey, dialect: dialect);

        var sets = new List<ResultSetBuffer>();
        var roomWaited = new SqlService.RoomWaited();
        ResultSetBuffer? currentSet = null;
        var statementSlot = 0;
        var discardedLocal = 0;
        long storedRows = 0;
        long rowsAffected = 0;
        var completed = 0;
        var batchNumber = 0;
        var iteration = 0;
        int? spid = null;
        string? login = null;
        var status = "succeeded";
        var commitInDoubt = false;
        MultiTargetError? failure = null;

        var errors = new List<string>();
        var suppressedErrors = 0;
        var raised = 0;
        (int Batch, int Iteration)? firstError = null;
        var delivered = new Queue<(int Number, byte State, int Line, string Message)>();

        int? SourceLine(SqlError item) => batchNumber > 0 && batchNumber <= batches.Count && batches[batchNumber - 1].SourceLinesSafe
            ? QueryMessages.ScriptLine(startLine, batches[batchNumber - 1].StartLine, item.LineNumber, item.Procedure)
            : null;

        string Describe(SqlError item)
        {
            var location = !string.IsNullOrEmpty(item.Procedure)
                ? "Procedure " + item.Procedure + ", Line " + item.LineNumber
                : batchNumber > 0 && item.LineNumber > 0
                    ? "Line " + (startLine + batches[batchNumber - 1].StartLine + item.LineNumber - 2)
                    : "Line " + item.LineNumber;
            return "Msg " + item.Number + ", Level " + item.Class + ", State " + item.State + ", " + location + "\n" + item.Message;
        }

        void Raise(string text, int? line = null)
        {
            target.Messages.Add(text, MessageKind.Error, line, targetKey, dialect);
            lock (errors)
            {
                raised++;
                if (errors.Count < 20) errors.Add(text);
                else suppressedErrors++;
            }
        }

        bool Delivered(SqlError item)
        {
            lock (errors) return delivered.Contains((item.Number, item.State, item.LineNumber, item.Message));
        }

        int Raised()
        {
            lock (errors) return raised;
        }

        string ErrorText(IEnumerable<string> terminating)
        {
            List<string> snapshot;
            int suppressed;
            lock (errors)
            {
                snapshot = [.. errors];
                suppressed = suppressedErrors;
            }
            var lines = terminating.Take(20).Concat(snapshot);
            if (suppressed > 0) lines = lines.Append("… and " + suppressed + " more errors.");
            var text = string.Join(Environment.NewLine, lines);
            return text.Length > 16384 ? text[..16384] + "…" : text;
        }

        void Report(SqlException error)
        {
            foreach (SqlError item in error.Errors)
            {
                if (item.Class <= 10)
                {
                    if (!SqlService.IsContextChange(item))
                        target.Messages.Add(item.Message, SqlService.InformationalKind(item.Number), targetKey: targetKey, dialect: dialect);
                }
                else if (!Delivered(item))
                {
                    Raise(Describe(item), SourceLine(item));
                }
            }
            if (!error.Errors.Cast<SqlError>().Any(item => item.Class > 10)) Raise(error.Message);
        }

        bool Continues(SqlException error, SqlConnection conn) =>
            !isTransaction && !target.StopOnError && !token.IsCancellationRequested
            && conn.State == ConnectionState.Open
            && error.Errors.Cast<SqlError>().All(item => item.Class < 20);

        SqlInfoMessageEventHandler onInfo = (_, e) =>
        {
            foreach (SqlError error in e.Errors)
            {
                if (error.Class <= 10)
                {
                    if (!SqlService.IsContextChange(error))
                        target.Messages.Add(error.Message, SqlService.InformationalKind(error.Number), targetKey: targetKey, dialect: dialect);
                    continue;
                }
                if (currentSet is not null) currentSet.Incomplete = true;
                lock (errors)
                {
                    delivered.Enqueue((error.Number, error.State, error.LineNumber, error.Message));
                    if (delivered.Count > 20) delivered.Dequeue();
                }
                Raise(Describe(error), SourceLine(error));
            }
        };

        target.Events.TargetState(new MultiQueryTargetStateEvent(
            targetKey, "running", 0, totalBatches, 0, 0, 0));

        SqlConnection? connection = null;
        var slotAcquired = false;
        var transferredToPhase2 = false;
        var supportsTxId = false;
        long? startTxId = null;

        try
        {
            token.ThrowIfCancellationRequested();
            AcquireEphemeralConnectionSlot();
            slotAcquired = true;

            connection = service.CreateConnection(target.Target.ConnectionId, target.Target.Database, stateful: true);
            connection.FireInfoMessageEventOnUserErrors = false;
            await service.OpenConnectionAsync(connection, token).ConfigureAwait(false);

            // Run SessionPrologue + LoginSql to establish SSMS defaults and capture SPID/login.
            await using (var prologue = connection.CreateCommand())
            {
                prologue.CommandText = service.Prologue + " " + SqlService.LoginSql;
                prologue.CommandTimeout = 0;
                using var stop = token.Register(SqlService.Attention, prologue);
                await using var reader = await prologue.ExecuteReaderAsync(token).ConfigureAwait(false);
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    login = reader.FieldCount >= 1 && !reader.IsDBNull(0) ? reader.GetString(0) : null;
                }
                spid = connection.ServerProcessId;
            }

            if (isTransaction)
            {
                var profile = service.Profile(target.Target.ConnectionId);
                supportsTxId = SupportsCurrentTransactionId(profile);
                await using var beginCmd = connection.CreateCommand();
                beginCmd.CommandText = supportsTxId ? BeginTransactionWithIdSql : BeginTransactionLegacySql;
                beginCmd.CommandTimeout = 0;
                using var stop = token.Register(SqlService.Attention, beginCmd);
                await using var beginReader = await beginCmd.ExecuteReaderAsync(token).ConfigureAwait(false);
                if (supportsTxId)
                {
                    startTxId = await ReadScalarInt64Async(beginReader, token).ConfigureAwait(false);
                    if (startTxId is null)
                    {
                        status = "failed";
                        const string msg = "Could not confirm the coordinated transaction identity after BEGIN TRANSACTION.";
                        target.Messages.Add(msg, MessageKind.Error, targetKey: targetKey, dialect: dialect);
                        failure = new MultiTargetError("SQL_ERROR", msg);
                    }
                }
                else
                {
                    var tranCount = await ReadScalarInt32Async(beginReader, token).ConfigureAwait(false);
                    if (tranCount is not >= 1)
                    {
                        status = "failed";
                        const string msg = "Could not confirm the coordinated transaction started (@@TRANCOUNT < 1).";
                        target.Messages.Add(msg, MessageKind.Error, targetKey: targetKey, dialect: dialect);
                        failure = new MultiTargetError("SQL_ERROR", msg);
                    }
                }
            }

            if (failure is null)
            {
                connection.InfoMessage += onInfo;
                connection.FireInfoMessageEventOnUserErrors = true;
                foreach (var marker in unbatched.Where(marker => marker.Name is not null))
                    nameNotes.Add(ResultNames.Unbatched(marker));
                namesBegun = true;

                for (var b = 0; b < batches.Count && failure is null; b++)
                {
                    batchNumber = b + 1;
                    var batch = batches[b];
                    if (batch.Markers is { Count: > 0 } && await ResultNamePlan.BuildAsync(batch, startLine, token).ConfigureAwait(false) is { } namePlan)
                    {
                        namePlans[b] = namePlan;
                        foreach (var note in namePlan.Notes) nameNotes.Add(note);
                    }
                    plannedBatches = b + 1;
                    nextRepetition = 1;

                    for (iteration = 1; iteration <= batch.RepeatCount && failure is null; iteration++)
                    {
                        token.ThrowIfCancellationRequested();
                        var raisedBefore = Raised();
                        var names = namePlans[b] is { Slots.Count: > 0 } placed ? new ResultNameBinder(placed) : null;
                        pendingNames = names;
                        pendingRepetition = batch.RepeatCount > 1 ? iteration : 0;
                        nextRepetition = iteration + 1;

                        await using var command = connection.CreateCommand();
                        command.CommandText = batch.Sql;
                        command.CommandTimeout = 0;
                        var statementStop = new ActionService.StatementStop(command, token);
                        connection.InfoMessage += statementStop.OnMessage;
                        using var stop = token.UnsafeRegister(static state => ((ActionService.StatementStop)state!).FromOtherThread(), statementStop);
                        command.StatementCompleted += (_, e) =>
                        {
                            if (e.RecordCount >= 0)
                            {
                                rowsAffected += e.RecordCount;
                                target.Messages.Add(
                                    e.RecordCount == 1 ? "(1 row affected)" : "(" + e.RecordCount + " rows affected)",
                                    MessageKind.Info, targetKey: targetKey, dialect: dialect);
                            }
                        };

                        SqlDataReader? reader = null;
                        var cutShort = false;
                        try
                        {
                            token.ThrowIfCancellationRequested();
                            reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, CancellationToken.None).ConfigureAwait(false);
                            var unread = true;
                            while (true)
                            {
                                try
                                {
                                    if (unread)
                                    {
                                        unread = false;
                                        ColumnPlan? plan = null;
                                        bool? hasLong = null;
                                        var skipped = false;
                                        var prefetched = false;
                                        var unkept = false;

                                        if (reader.FieldCount > 0)
                                        {
                                            var mayBePlan = ColumnPlan.MayBeExecutionPlan(reader);
                                            if (target.DiscardResults && !mayBePlan)
                                            {
                                                target.Quota.RecordDiscarded(1);
                                                discardedLocal++;
                                                statementSlot++;
                                                unkept = true;
                                                await DrainReaderAsync(reader, ColumnPlan.HasLongColumns(reader), token).ConfigureAwait(false);
                                            }
                                            else
                                            {
                                                prefetched = mayBePlan && await reader.ReadAsync(CancellationToken.None).ConfigureAwait(false);
                                                var prefix = prefetched ? ColumnPlan.ReadShowplanPrefix(reader) : null;
                                                var built = ColumnPlan.From(reader, prefix);
                                                if (target.DiscardResults && !built.IsPlan)
                                                {
                                                    target.Quota.RecordDiscarded(1);
                                                    discardedLocal++;
                                                    statementSlot++;
                                                    prefetched = false;
                                                    unkept = true;
                                                    await DrainReaderAsync(reader, built.HasLong, token).ConfigureAwait(false);
                                                }
                                                else
                                                {
                                                    var name = names?.Take(reader, built.IsPlan, Raised() != raisedBefore);
                                                    var descriptorCharge = built.DescriptorBytes + (name is null ? 0 : Encoding.UTF8.GetByteCount(name) + 8);
                                                    int? slot = built.IsPlan ? null : statementSlot++;

                                                    if (!target.Quota.TryAllocate(descriptorCharge, out var globalIndex, out _))
                                                    {
                                                        target.Quota.RecordDiscarded(1);
                                                        discardedLocal++;
                                                        names?.Stop("the run kept no more result sets");
                                                    }
                                                    else
                                                    {
                                                        var opened = service.Results.Open(
                                                            target.Budget,
                                                            globalIndex,
                                                            batchNumber,
                                                            iteration,
                                                            built.IsPlan ? "executionPlan" : "rows",
                                                            built.Columns,
                                                            built.Wires,
                                                            lengths: built.Lengths,
                                                            name: name,
                                                            targetKey: targetKey,
                                                            targetLabel: target.Target.Label,
                                                            targetEnvironment: target.Target.Environment,
                                                            targetProvider: dialect,
                                                            statementSlot: slot);

                                                        if (opened is not null)
                                                        {
                                                            plan = built;
                                                            currentSet = opened;
                                                            sets.Add(opened);
                                                            target.Events.Opened(opened);
                                                        }
                                                        else
                                                        {
                                                            target.Quota.Release(globalIndex, descriptorCharge);
                                                            target.Quota.RecordDiscarded(1);
                                                            discardedLocal++;
                                                            names?.Refused();
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        if (unkept) { /* Already drained above. */ }
                                        else if (plan?.ForXml is not null && currentSet is not null)
                                        {
                                            using var collector = new ForXmlCollector(service.Results, target.Budget);
                                            if (prefetched) collector.AppendRow(reader, token);
                                            while (await reader.ReadAsync(CancellationToken.None).ConfigureAwait(false))
                                                collector.AppendRow(reader, token);
                                            if (collector.Rows > 0)
                                            {
                                                currentSet.CountRow();
                                                target.Events.RowsChanged();
                                                if (target.MaxRows > 0 && storedRows >= target.MaxRows)
                                                    currentSet.Skip(TruncationReason.RowLimit);
                                                else if (collector.Stopped is not TruncationReason.None and var refused)
                                                {
                                                    currentSet.Skip(refused);
                                                    target.Budget.Stop(refused, collector.RefusedBytes);
                                                }
                                                else if (currentSet.BeginRow() is { } row)
                                                {
                                                    bool cut;
                                                    try { cut = collector.Write(row); }
                                                    catch { currentSet.AbortRow(); throw; }
                                                    if (currentSet.TryCommitRow(cut ? 1 : 0)) storedRows++;
                                                }
                                            }
                                        }
                                        else while (true)
                                        {
                                            if (skipped && (hasLong ??= plan?.HasLong ?? ColumnPlan.HasLongColumns(reader)))
                                            {
                                                if (currentSet?.SealDelay is not null)
                                                {
                                                    currentSet.Seal();
                                                    target.Events.Sealed(currentSet);
                                                }
                                                await SqlService.SkipRowsAsync(reader, currentSet, target.Events, token).ConfigureAwait(false);
                                                break;
                                            }
                                            var read = prefetched ? Task.FromResult(true) : reader.ReadAsync(CancellationToken.None);
                                            prefetched = false;
                                            if (!read.IsCompleted && currentSet?.SealDelay is { } delay
                                                && (delay == TimeSpan.Zero || await Task.WhenAny(read, Task.Delay(delay)).ConfigureAwait(false) != read))
                                            {
                                                currentSet.Seal();
                                                target.Events.Sealed(currentSet);
                                            }
                                            if (!await read.ConfigureAwait(false)) break;
                                            skipped = true;
                                            if (currentSet is null) continue;
                                            currentSet.CountRow();
                                            target.Events.RowsChanged();
                                            var planRow = plan?.IsPlan == true && currentSet.RowsRead == 1;
                                            if (!ResultSetTally.Stores(target.DiscardResults, target.MaxRows, storedRows, planRow))
                                            {
                                                currentSet.Skip(TruncationReason.RowLimit);
                                                continue;
                                            }
                                            var builder = currentSet.BeginRow();
                                            if (builder is null) continue;
                                            skipped = false;
                                            int truncatedCells;
                                            try { truncatedCells = plan!.ReadRow(reader, builder, warn, token); }
                                            catch { currentSet.AbortRow(); throw; }
                                            var sealedBefore = currentSet.SealedPages;
                                            var committed = currentSet.TryCommitRow(truncatedCells, mayWait: true);
                                            if (!committed && currentSet.RoomWanted > 0)
                                                committed = await SqlService.WaitAndCommitAsync(service.Results, currentSet, truncatedCells, roomWaited, token).ConfigureAwait(false);
                                            if (committed && !planRow) storedRows++;
                                            if (currentSet.SealedPages != sealedBefore) target.Events.Sealed(currentSet);
                                        }

                                        if (currentSet is not null)
                                        {
                                            currentSet.Complete();
                                            target.Events.Closed(currentSet);
                                            currentSet = null;
                                        }
                                    }
                                    if (!await reader.NextResultAsync(CancellationToken.None).ConfigureAwait(false)) break;
                                    unread = true;
                                }
                                catch (SqlException error) when (!reader.IsClosed && Continues(error, connection))
                                {
                                    Report(error);
                                    if (currentSet is not null)
                                    {
                                        currentSet.Incomplete = true;
                                        currentSet.Complete();
                                        target.Events.Closed(currentSet);
                                        currentSet = null;
                                    }
                                }
                            }
                            cutShort = token.IsCancellationRequested;
                        }
                        catch (Exception error)
                        {
                            try { command.Cancel(); } catch (Exception cancel) when (cancel is InvalidOperationException or SqlException) { }
                            if (error is not SqlException sql || !Continues(sql, connection)) throw;
                            Report(sql);
                            if (currentSet is not null)
                            {
                                currentSet.Incomplete = true;
                                currentSet.Complete();
                                target.Events.Closed(currentSet);
                                currentSet = null;
                            }
                        }
                        finally
                        {
                            if (reader is not null) await reader.DisposeAsync().ConfigureAwait(false);
                            connection.InfoMessage -= statementStop.OnMessage;
                        }

                        if (cutShort) throw new OperationCanceledException(token);

                        var batchFailed = Raised() != raisedBefore;
                        if (names is not null)
                        {
                            foreach (var note in names.Unapplied(batchFailed, null, batch.RepeatCount > 1 ? iteration : 0))
                                nameNotes.Add(note);
                        }
                        pendingNames = null;

                        if (isTransaction)
                        {
                            if (batchFailed)
                            {
                                status = "failed";
                                failure = new MultiTargetError("SQL_ERROR", ErrorText([]), batchNumber, iteration);
                                break;
                            }

                            // Post-batch transaction integrity probe: temporarily disable FireInfoMessageEventOnUserErrors and
                            // detach onInfo so SET STATISTICS TIME/IO never leak probe stats into Messages. Never run ExecuteAgainSql mid-script.
                            TransactionProbeResult probe;
                            connection.FireInfoMessageEventOnUserErrors = false;
                            connection.InfoMessage -= onInfo;
                            try
                            {
                                await using var probeCmd = connection.CreateCommand();
                                probeCmd.CommandText = supportsTxId ? ProbeTransactionWithIdSql : ProbeTransactionLegacySql;
                                probeCmd.CommandTimeout = 0;
                                using var probeStop = token.Register(SqlService.Attention, probeCmd);
                                await using var probeReader = await probeCmd.ExecuteReaderAsync(token).ConfigureAwait(false);
                                probe = await ReadTransactionProbeAsync(probeReader, supportsTxId, token).ConfigureAwait(false);
                            }
                            finally
                            {
                                connection.InfoMessage += onInfo;
                                connection.FireInfoMessageEventOnUserErrors = true;
                            }

                            if (Raised() != raisedBefore)
                            {
                                status = "failed";
                                failure = new MultiTargetError("SQL_ERROR", ErrorText([]), batchNumber, iteration);
                                break;
                            }

                            if (!probe.Valid)
                            {
                                status = "failed";
                                target.Messages.Add(probe.FailureReason!, MessageKind.Error, targetKey: targetKey, dialect: dialect);
                                failure = new MultiTargetError("SQL_ERROR", probe.FailureReason!, batchNumber, iteration);
                                break;
                            }

                            if (probe.TranCount == 0 || (supportsTxId && probe.TransactionId != startTxId))
                            {
                                commitInDoubt = true;
                                status = "commitInDoubt";
                                const string doubtMsg = "The script closed or replaced the coordinated transaction mid-execution without raising an error; commit outcome is in doubt. Check the data before retrying.";
                                target.Messages.Add(doubtMsg, MessageKind.Error, targetKey: targetKey, dialect: dialect);
                                failure = new MultiTargetError("SQL_ERROR", doubtMsg, batchNumber, iteration);
                                break;
                            }

                            if (probe.XactState != 1 || probe.TranCount < 1)
                            {
                                status = "failed";
                                var doomedMsg = "The coordinated transaction became uncommittable (XACT_STATE = " + probe.XactState.ToString(CultureInfo.InvariantCulture) + ").";
                                target.Messages.Add(doomedMsg, MessageKind.Error, targetKey: targetKey, dialect: dialect);
                                failure = new MultiTargetError("SQL_ERROR", doomedMsg, batchNumber, iteration);
                                break;
                            }
                        }
                        else
                        {
                            if (batchFailed && target.StopOnError)
                            {
                                status = "failed";
                                failure = new MultiTargetError("SQL_ERROR", ErrorText([]), batchNumber, iteration);
                                break;
                            }
                            if (batchFailed) firstError ??= (batchNumber, iteration);
                        }

                        completed++;
                        target.Events.TargetState(new MultiQueryTargetStateEvent(
                            targetKey, "running", completed, totalBatches, rowsAffected, sets.Count, watch.ElapsedMilliseconds));
                    }
                }

                if (!isTransaction && failure is null && firstError is { } firstErr)
                {
                    failure = new MultiTargetError("SQL_ERROR", ErrorText([]), firstErr.Batch, firstErr.Iteration);
                }

                // Fire-and-Forget mode: if @@TRANCOUNT > 0 after last batch, roll back before disposing and log info warning.
                if (target.Mode == "fireAndForget" && connection.State == ConnectionState.Open && !token.IsCancellationRequested)
                {
                    connection.FireInfoMessageEventOnUserErrors = false;
                    connection.InfoMessage -= onInfo;
                    try
                    {
                        using var checkCts = new CancellationTokenSource(TimeSpan.FromSeconds(RollbackTimeoutSeconds));
                        await using var checkCmd = connection.CreateCommand();
                        checkCmd.CommandText = SqlService.TransactionCountSql;
                        checkCmd.CommandTimeout = 0;
                        using var checkStop = checkCts.Token.Register(SqlService.Attention, checkCmd);
                        await using var checkReader = await checkCmd.ExecuteReaderAsync(checkCts.Token).ConfigureAwait(false);
                        var openTranCount = await ReadScalarInt32Async(checkReader, checkCts.Token).ConfigureAwait(false);
                        if (openTranCount is > 0)
                        {
                            await using var rbCmd = connection.CreateCommand();
                            rbCmd.CommandText = RollbackTransactionSql;
                            rbCmd.CommandTimeout = 0;
                            using var rbStop = checkCts.Token.Register(SqlService.Attention, rbCmd);
                            await rbCmd.ExecuteNonQueryAsync(checkCts.Token).ConfigureAwait(false);
                            target.Messages.Add(
                                "An open transaction remained at the end of the Fire-and-Forget run and was rolled back before closing the ephemeral session.",
                                MessageKind.Info, targetKey: targetKey, dialect: dialect);
                        }
                    }
                    catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException)
                    {
                        // Disposing the unpooled connection below ends the server session and rolls back any open transaction.
                    }
                }
            }
        }
        catch (RequestException error)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = "failed";
            target.Messages.Add(error.Message, MessageKind.Error, targetKey: targetKey, dialect: dialect);
            failure = new MultiTargetError(error.Code, error.Message, batchNumber > 0 ? batchNumber : null, iteration > 0 ? iteration : null);
        }
        catch (SqlException error)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = token.IsCancellationRequested ? "cancelled" : error.Number == -2 && batchNumber > 0 ? "timedOut" : "failed";
            foreach (SqlError item in error.Errors)
            {
                if (item.Class <= 10)
                {
                    if (!SqlService.IsContextChange(item))
                        target.Messages.Add(item.Message, SqlService.InformationalKind(item.Number), targetKey: targetKey, dialect: dialect);
                }
                else if (status == "failed" && !Delivered(item))
                {
                    target.Messages.Add(Describe(item), MessageKind.Error, SourceLine(item), targetKey, dialect);
                }
            }
            var details = error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(Describe).ToList();
            if (details.Count == 0)
            {
                details.Add(error.Message);
                if (status == "failed") target.Messages.Add(error.Message, MessageKind.Error, targetKey: targetKey, dialect: dialect);
            }
            var code = status == "failed" ? "SQL_ERROR" : status == "cancelled" ? "CANCELLED" : "TIMEOUT";
            var text = status == "failed" ? ErrorText(details) : status == "cancelled" ? "The query was cancelled." : "The query exceeded its execution timeout.";
            failure = new MultiTargetError(code, text, batchNumber > 0 ? batchNumber : null, iteration > 0 ? iteration : null);
        }
        catch (OperationCanceledException)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = "cancelled";
            failure = new MultiTargetError("CANCELLED", "The query was cancelled.", batchNumber > 0 ? batchNumber : null, iteration > 0 ? iteration : null);
        }
        catch (Exception error)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = "failed";
            var msg = "Execution stopped unexpectedly: " + error.Message;
            target.Messages.Add(msg, MessageKind.Error, targetKey: targetKey, dialect: dialect);
            failure = new MultiTargetError("BACKEND_ERROR", ErrorText([msg]), batchNumber > 0 ? batchNumber : null, iteration > 0 ? iteration : null);
        }
        finally
        {
            if (pendingNames is not null)
            {
                foreach (var note in pendingNames.Unapplied(true, "its batch stopped before its result set arrived", pendingRepetition))
                    nameNotes.Add(note);
            }
            if (namesBegun)
            {
                if (plannedBatches > 0 && namePlans[plannedBatches - 1] is { Slots.Count: > 0 } lastPlan && nextRepetition <= batches[plannedBatches - 1].RepeatCount)
                {
                    foreach (var note in ResultNameBinder.Unrun(lastPlan, nextRepetition, batches[plannedBatches - 1].RepeatCount, batches[plannedBatches - 1].RepeatCount > 1))
                        nameNotes.Add(note);
                }
                for (var b = plannedBatches; b < batches.Count; b++)
                {
                    foreach (var marker in batches[b].Markers ?? [])
                    {
                        if (marker.Name is not null)
                            nameNotes.Add(ResultNames.Note(marker, "was not applied: the run ended before its batch ran."));
                    }
                }
            }
            nameNotes.Finish();

            foreach (var set in sets.Where(set => set.IsOpen))
            {
                set.Complete();
                target.Events.Closed(set);
            }
        }

        // In Transaction mode, if Phase 1 succeeded cleanly and token is not cancelled, hand off to Phase 2 handle.
        if (isTransaction && status == "succeeded" && failure is null && !commitInDoubt && !token.IsCancellationRequested && connection is not null)
        {
            watch.Stop();
            var handle = new SqlServerPhase2Handle(service, connection, onInfo, sets, target, ReleaseEphemeralConnectionSlot);
            transferredToPhase2 = true;
            target.Events.TargetState(new MultiQueryTargetStateEvent(
                targetKey, "atBarrier", completed, totalBatches, rowsAffected, sets.Count, watch.ElapsedMilliseconds));
            var outcome = BuildOutcome(target, "succeeded", completed, totalBatches, rowsAffected, watch.ElapsedMilliseconds, sets, spid, login, null);
            return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(outcome, sets, NeedsCommit: true, discardedLocal), handle);
        }

        // Otherwise clean up connection now (including rollback of any open transaction on failed/cancelled Phase 1).
        try
        {
            if (connection is not null)
            {
                if (isTransaction)
                {
                    await RollbackAndDisposeAsync(connection, onInfo, !commitInDoubt ? sets : [], target.Events).ConfigureAwait(false);
                }
                else
                {
                    connection.FireInfoMessageEventOnUserErrors = false;
                    connection.InfoMessage -= onInfo;
                    await connection.DisposeAsync().ConfigureAwait(false);
                }
            }
        }
        finally
        {
            if (slotAcquired && !transferredToPhase2) ReleaseEphemeralConnectionSlot();
        }

        watch.Stop();
        EmitTerminalState(target, status, completed, totalBatches, rowsAffected, sets.Count, watch.ElapsedMilliseconds, failure);
        var finalOutcome = BuildOutcome(target, status, completed, totalBatches, rowsAffected, watch.ElapsedMilliseconds, sets, spid, login, failure);
        return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(finalOutcome, sets, NeedsCommit: false, discardedLocal), Phase2: null);
    }

    private static async Task DrainReaderAsync(DbDataReader reader, bool hasLong, CancellationToken token)
    {
        if (hasLong)
            await SqlService.SkipRowsAsync(reader, null, null, token).ConfigureAwait(false);
        else
            while (await reader.ReadAsync(CancellationToken.None).ConfigureAwait(false)) { }
    }

    internal static async Task RollbackAndDisposeAsync(
        SqlConnection connection,
        SqlInfoMessageEventHandler? onInfo,
        IReadOnlyList<ResultSetBuffer> setsToMarkPreview,
        QueryEventSink events)
    {
        try
        {
            connection.FireInfoMessageEventOnUserErrors = false;
            if (onInfo is not null) connection.InfoMessage -= onInfo;
            if (connection.State == ConnectionState.Open)
            {
                // Always use a fresh bounded 10 s CancellationToken (never the cancelled Phase 1 token).
                using var rollbackCts = new CancellationTokenSource(TimeSpan.FromSeconds(RollbackTimeoutSeconds));
                var rbToken = rollbackCts.Token;
                foreach (var sql in SqlService.ExecuteAgainSql)
                {
                    await using var resetCmd = connection.CreateCommand();
                    resetCmd.CommandText = sql;
                    resetCmd.CommandTimeout = 0;
                    using var stop = rbToken.Register(SqlService.Attention, resetCmd);
                    await resetCmd.ExecuteNonQueryAsync(rbToken).ConfigureAwait(false);
                }
                await using var rollbackCmd = connection.CreateCommand();
                rollbackCmd.CommandText = RollbackTransactionSql;
                rollbackCmd.CommandTimeout = 0;
                using var rbStop = rbToken.Register(SqlService.Attention, rollbackCmd);
                await rollbackCmd.ExecuteNonQueryAsync(rbToken).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException)
        {
            // Disposing the unpooled SqlConnection in finally ends the session so SQL Server rolls back any open transaction.
        }
        finally
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            MarkRolledBackPreview(setsToMarkPreview, events);
        }
    }

    internal static void MarkRolledBackPreview(IReadOnlyList<ResultSetBuffer> sets, QueryEventSink events)
    {
        foreach (var set in sets)
        {
            if (set.RolledBackPreview) continue;
            set.RolledBackPreview = true;
            events.ResultSetMeta(set.ResultId, rolledBackPreview: true);
        }
    }

    private static MultiTargetOutcome BuildOutcome(
        MultiTargetContext target,
        string status,
        int batchesCompleted,
        int batchesTotal,
        long rowsAffected,
        long elapsedMs,
        IReadOnlyList<ResultSetBuffer> sets,
        int? spid,
        string? login,
        MultiTargetError? error) =>
        new(
            target.Target.TargetKey,
            target.Provider,
            target.Target.Label,
            status,
            batchesCompleted,
            batchesTotal,
            rowsAffected,
            elapsedMs,
            [.. sets.Select(s => s.ResultId)],
            target.Target.Environment,
            spid,
            login,
            BytesProcessed: null,
            Job: null,
            Error: error);

    private static void EmitTerminalState(
        MultiTargetContext target,
        string phase,
        int batchesCompleted,
        int batchesTotal,
        long rowsAffected,
        int resultSetCount,
        long elapsedMs,
        MultiTargetError? error)
    {
        target.Events.TargetState(new MultiQueryTargetStateEvent(
            target.Target.TargetKey,
            phase,
            batchesCompleted,
            batchesTotal,
            rowsAffected,
            resultSetCount,
            elapsedMs,
            BytesProcessed: null,
            ErrorCode: error?.Code,
            ErrorMessage: error?.Message));
    }

    private sealed class SqlServerPhase2Handle(
        SqlService service,
        SqlConnection connection,
        SqlInfoMessageEventHandler onInfo,
        IReadOnlyList<ResultSetBuffer> sets,
        MultiTargetContext target,
        Action releaseEphemeralSlot) : IMultiTargetPhase2Handle
    {
        private int disposed;

        public async Task<MultiCommitResult> CommitAsync(CancellationToken token)
        {
            if (Volatile.Read(ref disposed) != 0)
                return new MultiCommitResult(MultiCommitOutcome.InDoubt, new MultiTargetError("SESSION_LOST", "The SQL session was already closed before commit completed."));

            try
            {
                connection.FireInfoMessageEventOnUserErrors = false;
                connection.InfoMessage -= onInfo;

                var commitSql = service.CommitSql;
                if (service.SessionFault?.Invoke(commitSql) is { } fault) throw fault;

                await using var command = connection.CreateCommand();
                command.CommandText = commitSql;
                command.CommandTimeout = 0;
                using var stop = token.Register(SqlService.Attention, command);
                await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
                var remaining = await ReadScalarInt32Async(reader, token).ConfigureAwait(false);
                if (remaining is 0)
                    return new MultiCommitResult(MultiCommitOutcome.Committed);

                var msg = "The transaction commit outcome could not be confirmed (@@TRANCOUNT is "
                    + (remaining?.ToString(CultureInfo.InvariantCulture) ?? "unknown") + " after COMMIT). Check the data before retrying.";
                return new MultiCommitResult(MultiCommitOutcome.InDoubt, new MultiTargetError("SQL_ERROR", msg));
            }
            catch (OperationCanceledException)
            {
                return new MultiCommitResult(
                    MultiCommitOutcome.InDoubt,
                    new MultiTargetError("CANCELLED", "Commit was interrupted before SQL Server confirmed completion; outcome is in doubt. Check the data before retrying."));
            }
            catch (SqlException error)
            {
                var details = string.Join(Environment.NewLine, error.Errors.Cast<SqlError>()
                    .Where(item => item.Class > 10)
                    .Select(item => "Msg " + item.Number + ", Level " + item.Class + ", State " + item.State + "\n" + item.Message));
                var msg = "Commit failed on SQL Server; outcome is in doubt. Check the data before retrying. " + (details.Length == 0 ? error.Message : details);
                return new MultiCommitResult(MultiCommitOutcome.InDoubt, new MultiTargetError("SQL_ERROR", msg));
            }
            catch (Exception error)
            {
                return new MultiCommitResult(
                    MultiCommitOutcome.InDoubt,
                    new MultiTargetError("BACKEND_ERROR", "Commit failed unexpectedly; outcome is in doubt. Check the data before retrying. " + error.Message));
            }
            finally
            {
                await DisposeAsync().ConfigureAwait(false);
            }
        }

        public async Task RollbackAsync(CancellationToken token)
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
            {
                MarkRolledBackPreview(sets, target.Events);
                return;
            }
            try
            {
                await RollbackAndDisposeAsync(connection, onInfo, sets, target.Events).ConfigureAwait(false);
            }
            finally
            {
                releaseEphemeralSlot();
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            try
            {
                connection.FireInfoMessageEventOnUserErrors = false;
                connection.InfoMessage -= onInfo;
                await connection.DisposeAsync().ConfigureAwait(false);
            }
            finally
            {
                releaseEphemeralSlot();
            }
        }
    }

    /// <summary>Walks every statement in a T-SQL batch to reject explicit COMMIT/ROLLBACK (without savepoint) and
    /// SQL Server Msg 226 / Msg 574 statements disallowed inside multi-statement transactions.</summary>
    private sealed class TransactionPreflightVisitor(int firstLine, int batchStartLine, int scriptStartColumn, List<TransactionScriptViolation> violations) : TSqlFragmentVisitor
    {
        public override void Visit(TSqlFragment node)
        {
            switch (node)
            {
                case CommitTransactionStatement:
                    Add(node, "COMMIT TRANSACTION", "Explicit COMMIT TRANSACTION is not allowed in Coordinated Transaction mode; Varia coordinates commit across all targets.");
                    break;
                case RollbackTransactionStatement rollback when rollback.Name is null:
                    Add(node, "ROLLBACK TRANSACTION", "Explicit ROLLBACK TRANSACTION without a savepoint name is not allowed in Coordinated Transaction mode.");
                    break;
                case CreateDatabaseStatement:
                    Add(node, "CREATE DATABASE", "CREATE DATABASE cannot run inside a coordinated transaction (SQL Server Msg 226).");
                    break;
                case AlterDatabaseStatement:
                    Add(node, "ALTER DATABASE", "ALTER DATABASE cannot run inside a coordinated transaction (SQL Server Msg 226).");
                    break;
                case DropDatabaseStatement:
                    Add(node, "DROP DATABASE", "DROP DATABASE cannot run inside a coordinated transaction (SQL Server Msg 226).");
                    break;
                case BackupStatement or BackupCertificateStatement or BackupMasterKeyStatement or BackupServiceMasterKeyStatement:
                    Add(node, "BACKUP", "BACKUP cannot run inside a coordinated transaction (SQL Server Msg 226).");
                    break;
                case RestoreStatement or RestoreMasterKeyStatement or RestoreServiceMasterKeyStatement:
                    Add(node, "RESTORE", "RESTORE cannot run inside a coordinated transaction (SQL Server Msg 226).");
                    break;
                case ReconfigureStatement:
                    Add(node, "RECONFIGURE", "RECONFIGURE cannot run inside a coordinated transaction (SQL Server Msg 226/574).");
                    break;
                case DbccStatement:
                    Add(node, "DBCC", "DBCC statements cannot run inside a coordinated transaction.");
                    break;
                case FullTextCatalogStatement or DropFullTextCatalogStatement
                    or CreateFullTextIndexStatement or AlterFullTextIndexStatement or DropFullTextIndexStatement
                    or CreateFullTextStopListStatement or AlterFullTextStopListStatement or DropFullTextStopListStatement
                    or CreateSearchPropertyListStatement or AlterSearchPropertyListStatement or DropSearchPropertyListStatement:
                    Add(node, "FULLTEXT DDL", "Full-Text DDL cannot run inside a coordinated transaction (SQL Server Msg 574).");
                    break;
                case AvailabilityGroupStatement or DropAvailabilityGroupStatement:
                    Add(node, "AVAILABILITY GROUP DDL", "Availability Group DDL cannot run inside a coordinated transaction (SQL Server Msg 574).");
                    break;
                case AlterServerConfigurationStatement
                    or AlterServerConfigurationSetBufferPoolExtensionStatement
                    or AlterServerConfigurationSetDiagnosticsLogStatement
                    or AlterServerConfigurationSetExternalAuthenticationStatement
                    or AlterServerConfigurationSetFailoverClusterPropertyStatement
                    or AlterServerConfigurationSetHadrClusterStatement
                    or AlterServerConfigurationSetSoftNumaStatement:
                    Add(node, "ALTER SERVER CONFIGURATION", "ALTER SERVER CONFIGURATION cannot run inside a coordinated transaction (SQL Server Msg 574).");
                    break;
                case ResourcePoolStatement or DropResourcePoolStatement
                    or ExternalResourcePoolStatement or DropExternalResourcePoolStatement
                    or WorkloadGroupStatement or DropWorkloadGroupStatement
                    or AlterResourceGovernorStatement:
                    Add(node, "RESOURCE POOL DDL", "Resource Pool / Resource Governor DDL cannot run inside a coordinated transaction (SQL Server Msg 574).");
                    break;
                case ShutdownStatement:
                    Add(node, "SHUTDOWN", "SHUTDOWN cannot run inside a coordinated transaction.");
                    break;
                case KillStatement or KillQueryNotificationSubscriptionStatement or KillStatsJobStatement:
                    Add(node, "KILL", "KILL cannot run inside a coordinated transaction.");
                    break;
            }
        }

        private void Add(TSqlFragment fragment, string kind, string detail)
        {
            var line = firstLine + Math.Max(1, fragment.StartLine) - 1;
            var col = ColumnOf(batchStartLine, fragment.StartLine, fragment.StartColumn, scriptStartColumn);
            violations.Add(new TransactionScriptViolation(
                line, col, kind,
                $"Line {line.ToString(CultureInfo.InvariantCulture)}: {detail}"));
        }
    }
}

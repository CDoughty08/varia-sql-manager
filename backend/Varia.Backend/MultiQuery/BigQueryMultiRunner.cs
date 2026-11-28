using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.MultiQuery;

/// <summary>
/// BigQuery target runner for <c>query.executeMulti</c> (docs/multi-server-query.md).
/// Holds <see cref="BigQueryConnection.Lease"/> for every participating connection across pre-flight, Phase 1, and Phase 2,
/// runs free <c>dryRun: true</c> / location resolution through <see cref="BigQueryService.MetadataAsync"/>, opens fresh
/// ephemeral sessions only in <c>transaction</c> mode (never for pure SELECT or Fire-and-Forget), verifies
/// <see cref="BigQueryTransaction.Open"/> over <c>ChildrenAsync(full: true)</c> after Phase 1, and delegates all row
/// ingestion through <see cref="SqlService"/>'s single-call BigQuery helpers so the working-memory lint invariants hold.
/// </summary>
internal sealed class BigQueryMultiRunner(SqlService service, CrossEngineRunner? crossEngine = null) : IMultiTargetRunner
{
    private const string BeginTransactionSql = "BEGIN TRANSACTION;";
    private readonly BigQueryService bigQuery = service.BigQuery;
    private readonly CrossEngineRunner crossEngine = crossEngine ?? new CrossEngineRunner(service, new ReadOnlySqlValidator());
    private readonly ConditionalWeakTable<QueryBudget, RunState> runs = new();

    public string Provider => Providers.BigQuery;

    private sealed class RunState(int bigQueryTargets)
    {
        public ConcurrentDictionary<string, string?> ResolvedLocations { get; } = new(StringComparer.Ordinal);
        public SqlService.MultiResidenceCoordinator Residence { get; } = new(bigQueryTargets);
    }

    private sealed class ChildReadFailure(Exception inner) : Exception(inner.Message, inner);

    public async Task<IReadOnlyList<MultiTargetPreflightOutcome>> PreflightAsync(IReadOnlyList<MultiTargetContext> targets, CancellationToken token)
    {
        if (targets.Count == 0) return [];
        var state = GetOrCreateRunState(targets[0].Budget, targets.Count);
        var mode = targets[0].Mode;

        // Transaction mode is never supported on the emulator (no sessions or multi-statement transactions).
        if (mode == "transaction" && bigQuery.Environment.Emulator)
        {
            var err = new MultiTargetError("UNSUPPORTED_PROVIDER",
                "BigQuery Transaction mode is not supported in emulator mode because the emulator does not support sessions or multi-statement transactions.");
            return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, false, err))];
        }

        // Same-engine modes share one SQL script across targets; check static blockers / legacy SQL once up front.
        if (mode == "transaction")
        {
            var sample = targets[0];
            if (BigQueryErrors.IsLegacySql(sample.Sql))
            {
                var err = new MultiTargetError("LEGACY_SQL", BigQueryErrors.LegacySql, Line: Math.Max(1, sample.StartLine));
                return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, false, err))];
            }
            var blockers = GoogleSqlScanner.FindTransactionBlockers(sample.Sql);
            if (blockers.Count > 0)
            {
                var first = blockers[0];
                var line = OffsetLine(sample.StartLine, first.Line);
                var err = new MultiTargetError("INVALID_SCRIPT", first.Message, Line: line);
                return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, false, err))];
            }
        }
        else if (mode == "crossEngineReadOnly")
        {
            var sample = targets[0];
            if (CrossEngineRunner.ValidateBigQueryStatic(sample.Sql, sample.StartLine) is { } err)
                return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, false, err))];
        }
        else if (BigQueryErrors.IsLegacySql(targets[0].Sql))
        {
            var err = new MultiTargetError("LEGACY_SQL", BigQueryErrors.LegacySql, Line: Math.Max(1, targets[0].StartLine));
            return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, false, err))];
        }

        var outcomes = new MultiTargetPreflightOutcome[targets.Count];
        using var gate = new SemaphoreSlim(Math.Min(targets.Count, 8));
        var tasks = new Task[targets.Count];
        for (var i = 0; i < targets.Count; i++)
        {
            var idx = i;
            var target = targets[idx];
            tasks[idx] = Task.Run(async () =>
            {
                await gate.WaitAsync(token);
                try
                {
                    outcomes[idx] = await PreflightTargetAsync(target, state, token);
                }
                finally
                {
                    gate.Release();
                }
            }, token);
        }
        await Task.WhenAll(tasks);
        return outcomes;
    }

    private async Task<MultiTargetPreflightOutcome> PreflightTargetAsync(MultiTargetContext ctx, RunState state, CancellationToken token)
    {
        var connection = bigQuery.Find(ctx.Target.ConnectionId);
        using var lease = connection?.Lease();
        if (connection is null || lease is null)
            return new(ctx.Target.TargetKey, false, new MultiTargetError("NOT_CONNECTED", "The BigQuery connection is no longer open."));

        if (ctx.Mode == "crossEngineReadOnly")
        {
            var (outcome, resolvedLocation) = await crossEngine.DryRunBigQueryTargetWithLocationAsync(ctx, ctx.Sql, ctx.StartLine, token);
            if (outcome.Passed) state.ResolvedLocations[ctx.Target.TargetKey] = resolvedLocation;
            return outcome;
        }

        var dataset = ctx.Target.NoDefaultDataset ? null : ctx.Target.Dataset ?? connection.Options.Dataset;
        var location = await service.ResolveBigQueryLocationAsync(connection, dataset, token);
        long? estimatedBytes = null;
        var dryRan = false;

        if (ctx.Mode == "transaction")
        {
            if (location is null)
            {
                if (GoogleSqlScanner.IsMultiStatementScript(ctx.Sql))
                {
                    return new(ctx.Target.TargetKey, false, new MultiTargetError("INVALID_PARAMS",
                        dataset is null
                            ? "BigQuery Transaction mode cannot resolve the location for a multi-statement script when the connection location is Automatic and no default dataset is set. Select a default dataset or configure an explicit connection location."
                            : $"BigQuery Transaction mode could not read the location of default dataset '{dataset}' while connection location is Automatic. Configure an explicit connection location."));
                }
                var (ok, estimate, error) = await TryDryRunAsync(ctx, connection, dataset, null, token);
                if (!ok) return new(ctx.Target.TargetKey, false, error);
                if (estimate!.StatementType == "SCRIPT" || estimate.Location is null)
                {
                    return new(ctx.Target.TargetKey, false, new MultiTargetError("INVALID_PARAMS",
                        dataset is null
                            ? "BigQuery Transaction mode could not determine a location for this query with location set to Automatic and no default dataset. Select a default dataset or configure an explicit connection location."
                            : $"BigQuery Transaction mode could not determine a location for this query using default dataset '{dataset}'. Configure an explicit connection location."));
                }
                location = estimate.Location;
                estimatedBytes = estimate.BytesProcessed;
                dryRan = true;
            }
            state.ResolvedLocations[ctx.Target.TargetKey] = location;
            if (ctx.PreflightDryRun && !dryRan)
            {
                var (ok, estimate, error) = await TryDryRunAsync(ctx, connection, dataset, location, token);
                if (!ok) return new(ctx.Target.TargetKey, false, error);
                estimatedBytes = estimate!.BytesProcessed;
                NoteIncompleteDryRun(ctx, estimate);
            }
            return new(ctx.Target.TargetKey, true, EstimatedBytes: estimatedBytes);
        }

        // Fire-and-Forget mode.
        state.ResolvedLocations[ctx.Target.TargetKey] = location;
        if (ctx.PreflightDryRun)
        {
            var (ok, estimate, error) = await TryDryRunAsync(ctx, connection, dataset, location, token);
            if (!ok) return new(ctx.Target.TargetKey, false, error);
            estimatedBytes = estimate!.BytesProcessed;
            if (location is null && estimate.Location is not null && estimate.StatementType != "SCRIPT")
                state.ResolvedLocations[ctx.Target.TargetKey] = estimate.Location;
            NoteIncompleteDryRun(ctx, estimate);
        }
        return new(ctx.Target.TargetKey, true, EstimatedBytes: estimatedBytes);
    }

    private async Task<(bool Ok, BigQueryEstimate? Estimate, MultiTargetError? Error)> TryDryRunAsync(
        MultiTargetContext ctx, BigQueryConnection connection, string? dataset, string? location, CancellationToken token)
    {
        try
        {
            var estimate = await bigQuery.EstimateAsync(connection, ctx.Sql, token, dataset: dataset, location: location);
            return (true, estimate, null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (RequestException error)
        {
            var rewritten = SqlService.EditorPositions(error.Message, ctx.StartLine, ctx.StartColumn, out var line);
            return (false, null, new MultiTargetError(error.Code, rewritten, Line: line));
        }
        catch (Exception error)
        {
            var mapped = BigQueryErrors.Map(error, connection.Options.Project, token: token) as RequestException
                ?? new RequestException("BACKEND_ERROR", "Dry run failed: " + BigQueryErrors.Sanitize(error.Message));
            var rewritten = SqlService.EditorPositions(mapped.Message, ctx.StartLine, ctx.StartColumn, out var line);
            return (false, null, new MultiTargetError(mapped.Code, rewritten, Line: line));
        }
    }

    private static void NoteIncompleteDryRun(MultiTargetContext ctx, BigQueryEstimate estimate)
    {
        if (estimate.Incomplete == "script")
        {
            ctx.Messages.Add("Dry run stopped at the first DDL or control statement; the actual bytes processed may be higher.",
                MessageKind.Info, targetKey: ctx.Target.TargetKey, dialect: Providers.BigQuery);
        }
    }

    public async Task<MultiTargetPhase1Outcome> ExecutePhase1Async(MultiTargetContext target, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var state = GetOrCreateRunState(target.Budget, 1);
        var connection = bigQuery.Find(target.Target.ConnectionId);
        var lease = connection?.Lease();
        if (connection is null || lease is null)
        {
            state.Residence.TargetCompleted();
            var missing = new MultiTargetError("NOT_CONNECTED", "The BigQuery connection is no longer open.");
            EmitTargetState(target, "failed", 0, 1, -1, 0, watch.ElapsedMilliseconds, null, missing);
            var failedOutcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "failed", 0, 1, -1,
                watch.ElapsedMilliseconds, [], target.Target.Environment, Error: missing);
            return new(new MultiTargetPhase1Result(failedOutcome, [], NeedsCommit: false));
        }

        var leaseTransferred = false;
        var isTransaction = target.Mode == "transaction";
        var project = connection.Options.Project;
        var dataset = target.Target.NoDefaultDataset ? null : target.Target.Dataset ?? connection.Options.Dataset;
        var cap = connection.Options.MaximumBytesBilled ?? target.Target.MaximumBytesBilled;
        var targetArgs = TargetQueryArgs(target, dataset, cap);
        var sets = new List<ResultSetBuffer>();
        var readChildren = new HashSet<string>(StringComparer.Ordinal);
        var roomWaited = new SqlService.RoomWaited();
        Action<string> warn = text => target.Messages.Add(text, MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
        var nameNotes = new ResultNameNotes(text => target.Messages.Add(text, MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery));
        BigQueryResultNameBinder? nameBinder = null;
        var namesPrepared = false;
        var namesFlushed = false;
        var isScript = false;
        var scriptListedAll = true;
        var scriptListingFailed = false;
        var scriptHasChildren = false;
        void PrepareNames()
        {
            if (namesPrepared) return;
            namesPrepared = true;
            var namePlan = BigQueryResultNamePlan.Build(target.Sql, target.StartLine);
            if (namePlan is null) return;
            foreach (var note in namePlan.Notes) nameNotes.Add(note);
            if (namePlan.Slots.Count > 0) nameBinder = new BigQueryResultNameBinder(namePlan);
        }
        void FlushNameNotes(string? ended)
        {
            if (namesFlushed) return;
            namesFlushed = true;
            if (nameBinder is not null)
            {
                foreach (var note in nameBinder.Unapplied(ended, isScript, scriptListedAll, scriptListingFailed, scriptHasChildren))
                    nameNotes.Add(note);
            }
            nameNotes.Finish();
        }

        ResultSetBuffer? currentSet = null;
        BigQueryTabSession? session = null;
        BigQueryJobSummary? summary = null;
        BigQueryJobException? jobFailed = null;
        var jobId = BigQueryService.NewJobId();
        string? beginJobId = null;
        string? location = null;
        var beginSent = false;
        var beginCreated = false;
        var beginDone = false;
        var beginInsertSettled = false;
        var beginStopAsked = 0;
        var sent = false;
        var created = false;
        var complete = false;
        var insertSettled = false;
        var verified = false;
        var indexMarked = false;
        long recordsAffected = -1;
        long childRowsAffected = -1;
        long keptRows = 0;
        var discarded = 0;
        var succeededChildren = 0;
        var statementSlot = 0;
        var stopAsked = 0;

        void StopJob()
        {
            if (target.IsAbandoned()) return;
            var loc = Volatile.Read(ref location);
            if (Volatile.Read(ref beginSent) && !Volatile.Read(ref beginDone) && Volatile.Read(ref beginInsertSettled)
                && Volatile.Read(ref beginJobId) is { } bid && Interlocked.Exchange(ref beginStopAsked, 1) == 0)
            {
                bigQuery.CancelJob(connection, project, bid, loc, maybeUnborn: !Volatile.Read(ref beginCreated));
            }
            if (Volatile.Read(ref sent) && !Volatile.Read(ref complete) && Volatile.Read(ref insertSettled)
                && Interlocked.Exchange(ref stopAsked, 1) == 0)
            {
                bigQuery.CancelJob(connection, project, jobId, loc, maybeUnborn: !Volatile.Read(ref created));
            }
        }

        async Task ChildAsync(BigQueryChild child, bool incompleteListing)
        {
            if (child.Error is not null) { nameBinder?.NoteChildError(); return; }
            succeededChildren++;
            var statement = child.StatementType;
            if (statement == "SELECT")
            {
                var slot = statementSlot++;
                if (target.DiscardResults)
                {
                    nameBinder?.TakeChild(child, incompleteListing, discarded: true);
                    discarded++;
                    target.Quota.RecordDiscarded();
                    return;
                }
                var first = await service.ReadBigQueryChildFirstPageAsync(connection, project, child.Id, child.Location ?? location, token);
                var childPlan = BigQueryColumnPlan.From(first.Schema);
                var rows = first.TotalRows ?? 0;
                if (childPlan is null)
                {
                    nameBinder?.StopPositional("a SELECT statement returned no columns, so the place of later result sets is unknown");
                    first.Dispose();
                    return;
                }
                if (childPlan.TruncatedColumns)
                    target.Messages.Add("The result has " + childPlan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.",
                        MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);

                var descriptorBytes = EstimateDescriptorBytes(childPlan.Columns);
                if (!target.Quota.TryAllocate(descriptorBytes, out var index, out var oversize))
                {
                    nameBinder?.RefusedChild(child, incompleteListing, "the run kept no more result sets");
                    first.Dispose();
                    discarded++;
                    target.Quota.RecordDiscarded();
                    if (oversize)
                        target.Messages.Add("Additional result sets were discarded because the response descriptor size cap was reached.",
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    return;
                }
                var childName = nameBinder?.TakeChild(child, incompleteListing);
                var set = service.Results.Open(target.Budget, index, 1, 1, "rows", childPlan.Columns, childPlan.Wires,
                    lengths: childPlan.Lengths, name: childName, targetKey: target.Target.TargetKey, targetLabel: target.Target.Label,
                    targetEnvironment: target.Target.Environment, targetProvider: Providers.BigQuery, statementSlot: slot < 1000 ? slot : null);
                if (set is null)
                {
                    nameBinder?.RefusedLast("result memory kept no more result sets");
                    target.Quota.Release(index, descriptorBytes);
                    first.Dispose();
                    discarded++;
                    target.Quota.RecordDiscarded();
                    return;
                }
                var left = target.MaxRows > 0 ? target.MaxRows - keptRows : long.MaxValue;
                var childArgs = target.MaxRows <= 0 ? targetArgs : left > 0 ? targetArgs with { MaxRows = (int)left } : targetArgs with { Residence = "memory" };
                var keptBefore = left > 0 ? 0 : keptRows;
                sets.Add(set);
                currentSet = set;
                await service.IngestBigQueryChildResultAsync(childArgs, connection, project, child.Id, child.Location ?? location,
                    childPlan, first, set, target.Budget, rows, roomWaited, target.Events, warn, target.Messages, target.MaxRows, keptBefore, token, state.Residence);
                set.Complete();
                keptRows += set.RowsAvailable;
                target.Events.Closed(set);
                currentSet = null;
                target.Messages.Add(rows == 1 ? "(1 row affected)" : "(" + rows.ToString(CultureInfo.InvariantCulture) + " rows affected)",
                    MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
            }
            else if (child.DmlAffected is { } affected and >= 0)
            {
                childRowsAffected = Math.Max(0, childRowsAffected) + affected;
                target.Messages.Add(affected == 1 ? "(1 row affected)" : "(" + affected.ToString(CultureInfo.InvariantCulture) + " rows affected)",
                    MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
            }
            else if (statement is { Length: > 0 })
            {
                target.Messages.Add(SqlService.StatementSentence(statement, child.Ddl),
                    MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
            }
        }

        async Task<(List<BigQueryChild> Children, bool Complete)> ChildrenAsync(bool full, bool readRows = true)
        {
            var listed = await bigQuery.ChildrenAsync(connection, project, jobId, full ? null : readChildren, token);
            if (!readRows || (!full && !listed.Complete)) return listed;
            await ReadChildrenAsync(listed.Children, incompleteListing: !listed.Complete);
            return listed;
        }

        async Task ReadChildrenAsync(List<BigQueryChild> listedChildren, bool incompleteListing)
        {
            foreach (var child in listedChildren)
            {
                if (readChildren.Contains(child.Id)) continue;
                if (!child.Done) break;
                readChildren.Add(child.Id);
                try { await ChildAsync(child, incompleteListing); }
                catch (Exception error) when (!token.IsCancellationRequested) { throw new ChildReadFailure(error); }
            }
        }

        var emittedDone = false;
        using var stopRegistration = token.Register(StopJob);
        EmitTargetState(target, "running", 0, 1, -1, 0, watch.ElapsedMilliseconds, null, null);

        try
        {
            // Defense-in-depth checks when ExecutePhase1Async is invoked without PreflightAsync.
            MultiTargetPhase1Outcome FailEarly(MultiTargetError err)
            {
                target.Messages.Add(err.Message, MessageKind.Error, err.Line, target.Target.TargetKey, Providers.BigQuery);
                EmitTargetState(target, "failed", 0, 1, -1, 0, watch.ElapsedMilliseconds, null, err);
                var outcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "failed",
                    0, 1, -1, watch.ElapsedMilliseconds, [], target.Target.Environment, Error: err);
                return new(new MultiTargetPhase1Result(outcome, sets, NeedsCommit: false, discarded));
            }
            if (isTransaction && bigQuery.Environment.Emulator)
                return FailEarly(new("UNSUPPORTED_PROVIDER", "BigQuery Transaction mode is not supported in emulator mode because the emulator does not support sessions or multi-statement transactions."));
            if (target.Mode == "crossEngineReadOnly" && CrossEngineRunner.ValidateBigQueryStatic(target.Sql, target.StartLine) is { } staticErr)
                return FailEarly(staticErr);
            if (BigQueryErrors.IsLegacySql(target.Sql))
                return FailEarly(new("LEGACY_SQL", BigQueryErrors.LegacySql, Line: target.StartLine));
            if (isTransaction)
            {
                var blockers = GoogleSqlScanner.FindTransactionBlockers(target.Sql);
                if (blockers.Count > 0)
                    return FailEarly(new("INVALID_SCRIPT", blockers[0].Message, Line: OffsetLine(target.StartLine, blockers[0].Line)));
            }
            PrepareNames();

            if (!state.ResolvedLocations.TryGetValue(target.Target.TargetKey, out location))
            {
                location = await service.ResolveBigQueryLocationAsync(connection, dataset, token);
                if (isTransaction && location is null)
                {
                    if (GoogleSqlScanner.IsMultiStatementScript(target.Sql))
                        throw new RequestException("INVALID_PARAMS",
                            dataset is null
                                ? "BigQuery Transaction mode cannot resolve the location for a multi-statement script when the connection location is Automatic and no default dataset is set. Select a default dataset or configure an explicit connection location."
                                : $"BigQuery Transaction mode could not read the location of default dataset '{dataset}' while connection location is Automatic. Configure an explicit connection location.");
                    var est = await bigQuery.EstimateAsync(connection, target.Sql, token, dataset: dataset);
                    if (est.StatementType == "SCRIPT" || est.Location is null)
                        throw new RequestException("INVALID_PARAMS",
                            dataset is null
                                ? "BigQuery Transaction mode could not determine a location for this query with location set to Automatic and no default dataset. Select a default dataset or configure an explicit connection location."
                                : $"BigQuery Transaction mode could not determine a location for this query using default dataset '{dataset}'. Configure an explicit connection location.");
                    location = est.Location;
                }
                state.ResolvedLocations[target.Target.TargetKey] = location;
            }
            Volatile.Write(ref location, location);

            // Transaction mode: open a fresh ephemeral session (createSession: true) and BEGIN TRANSACTION.
            if (isTransaction)
            {
                session = new BigQueryTabSession("multi:" + target.QueryId + ":" + target.Target.TargetKey, connection) { Location = location };
                var nextBeginJobId = BigQueryService.NewJobId();
                Volatile.Write(ref beginJobId, nextBeginJobId);
                var beginJob = new Job
                {
                    JobReference = new JobReference { ProjectId = project, JobId = nextBeginJobId, Location = location },
                    Configuration = new JobConfiguration
                    {
                        Labels = new Dictionary<string, string>(BigQueryService.Labels),
                        JobTimeoutMs = target.TimeoutSeconds > 0 ? target.TimeoutSeconds * 1000L : null,
                        Query = new JobConfigurationQuery
                        {
                            Query = BeginTransactionSql,
                            UseLegacySql = false,
                            DefaultDataset = dataset is null ? null : new DatasetReference { ProjectId = project, DatasetId = dataset },
                            MaximumBytesBilled = BigQueryService.SessionControlCap,
                            CreateSession = true
                        }
                    }
                };
                token.ThrowIfCancellationRequested();
                Volatile.Write(ref beginSent, true);
                Job beginInserted;
                try
                {
                    beginInserted = await bigQuery.InsertJobAsync(connection, beginJob, dataset, token);
                    Volatile.Write(ref location, SqlService.KnownLocation(beginInserted.JobReference?.Location) ?? location);
                    Volatile.Write(ref beginCreated, true);
                }
                catch (Exception error) when (BigQueryService.NeverCreated(error))
                {
                    Volatile.Write(ref beginSent, false);
                    throw;
                }
                finally
                {
                    Volatile.Write(ref location, Volatile.Read(ref location) ?? SqlService.KnownLocation(beginJob.JobReference?.Location));
                    Volatile.Write(ref beginInsertSettled, true);
                    if (token.IsCancellationRequested) StopJob();
                }
                BigQueryService.CaptureSession(session, beginInserted, location);
                var beginFinished = beginInserted.Status?.State == "DONE"
                    ? beginInserted
                    : await bigQuery.WaitDoneAsync(connection, project, nextBeginJobId, location, token);
                Volatile.Write(ref beginDone, true);
                Volatile.Write(ref location, SqlService.KnownLocation(beginFinished.JobReference?.Location) ?? location);
                BigQueryService.CaptureSession(session, beginFinished, location);
                if (BigQueryJobException.Of(beginFinished) is { } beginFailed) throw beginFailed;
                if (session.Id is null)
                    throw new RequestException("BACKEND_ERROR", "BigQuery did not return a session ID for the transaction.");
                session.Location = location;
                session.Transaction = BigQueryTransaction.Open;
            }

            // Submit the user script job (inside the ephemeral session for Transaction mode, or sessionless otherwise).
            var job = new Job
            {
                JobReference = new JobReference { ProjectId = project, JobId = jobId, Location = location },
                Configuration = new JobConfiguration
                {
                    Labels = new Dictionary<string, string>(BigQueryService.Labels),
                    JobTimeoutMs = target.TimeoutSeconds > 0 ? target.TimeoutSeconds * 1000L : null,
                    Query = new JobConfigurationQuery
                    {
                        Query = target.Sql,
                        UseLegacySql = false,
                        DefaultDataset = dataset is null ? null : new DatasetReference { ProjectId = project, DatasetId = dataset },
                        MaximumBytesBilled = cap,
                        CreateSession = null,
                        ConnectionProperties = session?.Id is { } sessionId ? [new ConnectionProperty { Key = "session_id", Value = sessionId }] : null
                    }
                }
            };
            token.ThrowIfCancellationRequested();
            Volatile.Write(ref sent, true);
            Job inserted;
            try
            {
                inserted = await bigQuery.InsertJobAsync(connection, job, dataset, token);
                Volatile.Write(ref location, SqlService.KnownLocation(inserted.JobReference?.Location) ?? location);
                Volatile.Write(ref created, true);
            }
            catch (Exception error) when (BigQueryService.NeverCreated(error))
            {
                Volatile.Write(ref sent, false);
                throw;
            }
            finally
            {
                Volatile.Write(ref location, Volatile.Read(ref location) ?? SqlService.KnownLocation(job.JobReference?.Location));
                Volatile.Write(ref insertSettled, true);
                if (token.IsCancellationRequested) StopJob();
            }
            bigQuery.Reached();
            target.Messages.Add("BigQuery job " + SqlService.JobName(project, location, jobId) + ".",
                MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
            var refused = BigQueryJobException.Of(inserted);
            var refusedNeedsScriptVerify = refused is not null && isTransaction
                && (BigQueryService.StatementOf(inserted.Statistics) == "SCRIPT" || inserted.Statistics?.NumChildJobs > 0);
            target.Events.Job(SqlService.JobEvent(project, jobId, location, refused is null || refusedNeedsScriptVerify ? "running" : "done",
                session?.Transaction ?? BigQueryTransaction.None, target.Target.TargetKey));
            if (refused is not null)
            {
                Volatile.Write(ref complete, true);
                if (!refusedNeedsScriptVerify)
                {
                    emittedDone = true;
                    Volatile.Write(ref verified, true);
                }
                throw refused;
            }

            // Poll the job and read completed script children incrementally (deferring child row reads in Transaction mode
            // until post-Phase-1 COMMIT_TRANSACTION verification finishes so a ChildReadFailure cannot bypass sawCommit).
            BigQueryPage? page = null;
            var listing = !isTransaction;
            try
            {
                try
                {
                    while (true)
                    {
                        token.ThrowIfCancellationRequested();
                        page = await service.PollBigQueryFirstPageAsync(connection, project, jobId, location, target.DiscardResults, token);
                        if (page.JobComplete) break;
                        page.Dispose();
                        page = null;
                        if (!listing) continue;
                        try { if (!(await ChildrenAsync(full: false)).Complete) listing = false; }
                        catch (Exception error) when (!token.IsCancellationRequested && error is not ChildReadFailure) { listing = false; }
                    }
                }
                catch (BigQueryJobException error) { jobFailed = error; }

                Volatile.Write(ref complete, true);
                var finished = await bigQuery.GetJobAsync(connection, project, jobId, location, token);
                summary = SqlService.JobSummary(project, location, jobId, finished);
                var statement = summary.StatementType;
                var script = statement == "SCRIPT" || readChildren.Count > 0 || finished.Statistics?.NumChildJobs > 0;
                isScript = script;
                List<BigQueryChild>? children = null;
                var listedAll = false;
                if (script)
                {
                    try
                    {
                        (children, listedAll) = await ChildrenAsync(full: true, readRows: false);
                        if (children is not null && ((finished.Statistics?.NumChildJobs is { } expectedChildren && children.Count < expectedChildren) || children.Any(c => !c.Done)))
                            listedAll = false;
                        if (!isTransaction && children is not null)
                            await ReadChildrenAsync(children, incompleteListing: !listedAll);
                    }
                    catch (Exception error) when (!token.IsCancellationRequested && error is not (BigQueryJobException or ChildReadFailure))
                    {
                        children = null;
                        listedAll = false;
                    }
                    scriptListedAll = listedAll;
                    scriptListingFailed = children is null;
                    scriptHasChildren = children is { Count: > 0 };
                }
                service.MarkBigQueryIndex(target.Target.ConnectionId, connection, finished, statement, children, listedAll, project, dataset, target.Sql);
                indexMarked = true;

                // Post-Phase-1 transaction verification over ChildrenAsync(full: true) BEFORE reading child/top-level rows.
                var sawCommit = false;
                if (isTransaction && session is not null)
                {
                    var txState = BigQueryTransaction.Open;
                    if (!script)
                    {
                        if (statement == "COMMIT_TRANSACTION" && jobFailed is null) sawCommit = true;
                        txState = BigQueryService.Apply(txState, statement, jobFailed is not null);
                    }
                    else if (children is not null)
                    {
                        foreach (var child in children)
                        {
                            if (child.StatementType == "COMMIT_TRANSACTION" && (!child.Done || child.Error is null)) sawCommit = true;
                            if (listedAll)
                                txState = BigQueryService.Apply(txState, child.StatementType, child.Error is not null || !child.Done);
                        }
                        if (!listedAll)
                            txState = sawCommit ? BigQueryTransaction.None : BigQueryTransaction.Unknown;
                        else if (jobFailed is not null && !children.Any(c => c.Error is not null || !c.Done))
                            txState = BigQueryService.Apply(txState, statement, failed: true);
                    }
                    else
                    {
                        txState = BigQueryTransaction.Unknown;
                    }
                    session.Transaction = txState;
                }
                Volatile.Write(ref verified, true);

                emittedDone = true;
                target.Events.Job(SqlService.JobEvent(project, jobId, location, "done",
                    session?.Transaction ?? BigQueryTransaction.None, target.Target.TargetKey));

                if (sawCommit)
                {
                    // A statement inside the script committed before the coordinated barrier: mark commitInDoubt and abort peers.
                    if (session?.Id is { } sid && !target.IsAbandoned())
                        await bigQuery.AbortEphemeralSessionAsync(connection, sid, session.Location);
                    FlushNameNotes("the run stopped before its result set arrived");
                    var inDoubtError = new MultiTargetError("SQL_ERROR",
                        "A statement executed COMMIT TRANSACTION before the coordinated barrier, so changes on this BigQuery target may already be committed.");
                    target.Messages.Add(inDoubtError.Message, MessageKind.Error, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    EmitTargetState(target, "commitInDoubt", 1, 1, recordsAffected, sets.Count, watch.ElapsedMilliseconds, summary.BytesProcessed, inDoubtError);
                    var inDoubtOutcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "commitInDoubt",
                        1, 1, recordsAffected, watch.ElapsedMilliseconds, [.. sets.Select(s => s.ResultId)], target.Target.Environment,
                        BytesProcessed: summary.BytesProcessed, Job: summary, Error: inDoubtError);
                    return new(new MultiTargetPhase1Result(inDoubtOutcome, sets, NeedsCommit: false, discarded));
                }

                if (isTransaction && session is not null && jobFailed is null && session.Transaction != BigQueryTransaction.Open)
                {
                    if (session.Id is { } sid && !target.IsAbandoned())
                        await bigQuery.AbortEphemeralSessionAsync(connection, sid, session.Location);
                    FlushNameNotes("the run failed before its result set arrived");
                    if (BigQueryCost.Summary(summary, target.Prices != false) is { } failCost)
                        target.Messages.Add(failCost, MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    var reason = session.Transaction == BigQueryTransaction.Unknown
                        ? "Varia could not verify that the BigQuery transaction remained open (script child listing was incomplete or unavailable), so the coordinated transaction was aborted."
                        : "The BigQuery transaction is no longer open after Phase 1, so the coordinated transaction was aborted.";
                    var txErr = new MultiTargetError("SQL_ERROR", reason);
                    target.Messages.Add(reason, MessageKind.Error, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    EmitTargetState(target, "failed", 1, 1, recordsAffected, sets.Count, watch.ElapsedMilliseconds, summary.BytesProcessed, txErr);
                    var abortedOutcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "failed",
                        1, 1, recordsAffected, watch.ElapsedMilliseconds, [.. sets.Select(s => s.ResultId)], target.Target.Environment,
                        BytesProcessed: summary.BytesProcessed, Job: summary, Error: txErr);
                    return new(new MultiTargetPhase1Result(abortedOutcome, sets, NeedsCommit: false, discarded));
                }

                if (isTransaction && script && children is not null)
                {
                    if (jobFailed is not null)
                    {
                        try { await ReadChildrenAsync(children, incompleteListing: !listedAll); }
                        catch (Exception ex) when (ex is not OutOfMemoryException) { }
                    }
                    else
                    {
                        await ReadChildrenAsync(children, incompleteListing: !listedAll);
                    }
                }

                if (jobFailed is not null)
                {
                    if (succeededChildren > 0)
                        target.Messages.Add(succeededChildren == 1 ? "1 statement before the failing one ran, and BigQuery billed it."
                            : succeededChildren.ToString(CultureInfo.InvariantCulture) + " statements before the failing one ran, and BigQuery billed them.",
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    throw jobFailed;
                }

                if (script && children is not null && !listedAll)
                    target.Messages.Add(SqlService.IncompleteScript, MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);

                if (script && children is { Count: > 0 })
                {
                    if (childRowsAffected >= 0) recordsAffected = childRowsAffected;
                    target.Messages.Add("The script completed.", MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                }
                else
                {
                    if (script && children is null)
                        target.Messages.Add("Varia could not list the script's statements, so only the last statement's rows are shown.",
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    var plan = page is null ? null : BigQueryColumnPlan.From(page.Schema);
                    var totalRows = page?.TotalRows ?? 0;
                    if (page?.NumDmlAffectedRows is { } affected) recordsAffected = affected;
                    if (plan is not null && target.DiscardResults)
                    {
                        nameBinder?.DiscardSingle(script);
                        discarded++;
                        target.Quota.RecordDiscarded();
                    }
                    else if (plan is not null && page is not null)
                    {
                        if (plan.TruncatedColumns)
                            target.Messages.Add("The result has " + plan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.",
                                MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                        var descriptorBytes = EstimateDescriptorBytes(plan.Columns);
                        if (!target.Quota.TryAllocate(descriptorBytes, out var index, out var oversize))
                        {
                            if (nameBinder?.TakeSingle(script, listingFailed: script && children is null, noChildren: script && children is { Count: 0 }) is not null)
                                nameBinder.RefusedLast("the run kept no more result sets");
                            discarded++;
                            target.Quota.RecordDiscarded();
                            if (oversize)
                                target.Messages.Add("Additional result sets were discarded because the response descriptor size cap was reached.",
                                    MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                        }
                        else
                        {
                            var slot = statementSlot++;
                            var resultName = nameBinder?.TakeSingle(script, listingFailed: script && children is null, noChildren: script && children is { Count: 0 });
                            currentSet = service.Results.Open(target.Budget, index, 1, 1, "rows", plan.Columns, plan.Wires,
                                lengths: plan.Lengths, name: resultName, targetKey: target.Target.TargetKey, targetLabel: target.Target.Label,
                                targetEnvironment: target.Target.Environment, targetProvider: Providers.BigQuery, statementSlot: slot < 1000 ? slot : null);
                            if (currentSet is null)
                            {
                                nameBinder?.RefusedLast("result memory kept no more result sets");
                                target.Quota.Release(index, descriptorBytes);
                                discarded++;
                                target.Quota.RecordDiscarded();
                            }
                            else
                            {
                                sets.Add(currentSet);
                                var readingPage = page;
                                page = null;
                                await service.IngestBigQueryTopLevelResultAsync(targetArgs, connection, project, jobId, location, finished,
                                    plan, readingPage, currentSet, target.Budget, totalRows, roomWaited, target.Events, warn, target.Messages, token, state.Residence);
                                currentSet.Complete();
                                target.Events.Closed(currentSet);
                                currentSet = null;
                            }
                        }
                    }
                    if (recordsAffected < 0 && finished.Statistics?.Query?.NumDmlAffectedRows is { } dml and >= 0) recordsAffected = dml;
                    if (recordsAffected >= 0)
                        target.Messages.Add(recordsAffected == 1 ? "(1 row affected)" : "(" + recordsAffected.ToString(CultureInfo.InvariantCulture) + " rows affected)",
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    else if (plan is not null)
                        target.Messages.Add(totalRows == 1 ? "(1 row affected)" : "(" + totalRows.ToString(CultureInfo.InvariantCulture) + " rows affected)",
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    else if (statement == "SCRIPT")
                        target.Messages.Add("The script completed.", MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                    else if (statement is { Length: > 0 } && statement != "SELECT")
                        target.Messages.Add(SqlService.StatementSentence(statement, finished.Statistics?.Query?.DdlOperationPerformed),
                            MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                }

                FlushNameNotes(ended: null);
                if (BigQueryCost.Summary(summary, target.Prices != false) is { } cost)
                    target.Messages.Add(cost, MessageKind.Info, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);

                // In Transaction mode, session.Transaction was already verified Open above; enter the coordinated barrier.
                if (isTransaction && session is not null)
                {
                    EmitTargetState(target, "atBarrier", 1, 1, recordsAffected, sets.Count, watch.ElapsedMilliseconds, summary.BytesProcessed, null);
                    var phase2 = new BigQueryPhase2Handle(bigQuery, connection, lease, session, sets, target.Events, target.IsAbandoned);
                    leaseTransferred = true;
                    var readyOutcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "succeeded",
                        1, 1, recordsAffected, watch.ElapsedMilliseconds, [.. sets.Select(s => s.ResultId)], target.Target.Environment,
                        BytesProcessed: summary.BytesProcessed, Job: summary);
                    return new(new MultiTargetPhase1Result(readyOutcome, sets, NeedsCommit: true, discarded), phase2);
                }

                EmitTargetState(target, "succeeded", 1, 1, recordsAffected, sets.Count, watch.ElapsedMilliseconds, summary.BytesProcessed, null);
                var doneOutcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, "succeeded",
                    1, 1, recordsAffected, watch.ElapsedMilliseconds, [.. sets.Select(s => s.ResultId)], target.Target.Environment,
                    BytesProcessed: summary.BytesProcessed, Job: summary);
                return new(new MultiTargetPhase1Result(doneOutcome, sets, NeedsCommit: false, discarded));
            }
            finally
            {
                page?.Dispose();
            }
        }
        catch (Exception error)
        {
            var cancelledAtCatch = token.IsCancellationRequested;
            var timedOutAtCatch = target.IsTimedOut?.Invoke() == true;
            var userCancelledAtCatch = target.IsUserCancelled?.Invoke() == true;
            var childFailed = error is ChildReadFailure;
            if (error is ChildReadFailure read) error = read.InnerException!;

            var curLocation = Volatile.Read(ref location);
            var wasSent = Volatile.Read(ref sent);
            var wasCreated = Volatile.Read(ref created);
            var wasComplete = Volatile.Read(ref complete);
            var wasVerified = Volatile.Read(ref verified);

            if (childFailed && wasSent && !wasComplete && !target.IsAbandoned())
                bigQuery.CancelJob(connection, project, jobId, curLocation, maybeUnborn: !wasCreated);

            if (currentSet is not null)
            {
                currentSet.Incomplete = true;
                if (currentSet.IsOpen)
                {
                    currentSet.Complete();
                    target.Events.Closed(currentSet);
                }
                currentSet = null;
            }

            if (wasSent && !indexMarked && (wasCreated || error is BigQueryJobMayExist { Exists: true }))
                service.MarkBigQueryIndexWhenDone(target.Target.ConnectionId, connection, project, jobId, curLocation, dataset, target.Sql);

            var committedOrUnverified = false;
            var jobSettledDone = wasComplete;
            var unverifiedReason = false;
            if (isTransaction && session is not null && !target.IsAbandoned())
            {
                // If BEGIN TRANSACTION setup was interrupted before completion, cancel it and capture any created session ID before aborting.
                if (Volatile.Read(ref beginSent) && !Volatile.Read(ref beginDone) && Volatile.Read(ref beginJobId) is { } bid)
                {
                    var beginWasCreated = Volatile.Read(ref beginCreated);
                    if (Interlocked.Exchange(ref beginStopAsked, 1) == 0)
                        bigQuery.CancelJob(connection, project, bid, curLocation, maybeUnborn: !beginWasCreated);
                    if (session.Id is null && (beginWasCreated || cancelledAtCatch || !BigQueryService.NeverCreated(error)))
                    {
                        try
                        {
                            using var beginSettleCts = CancellationTokenSource.CreateLinkedTokenSource(bigQuery.Stopping);
                            beginSettleCts.CancelAfter(beginWasCreated ? bigQuery.CloseWaitLimit : bigQuery.UnbornCancelLimit + bigQuery.CloseWaitLimit);
                            var beginUnbornWatch = System.Diagnostics.Stopwatch.StartNew();
                            while (true)
                            {
                                try
                                {
                                    var foundBegin = await bigQuery.GetJobAsync(connection, project, bid, curLocation, beginSettleCts.Token);
                                    BigQueryService.CaptureSession(session, foundBegin, SqlService.KnownLocation(foundBegin.JobReference?.Location) ?? curLocation);
                                    if (session.Id is not null || foundBegin.Status?.State == "DONE") break;
                                    await Task.Delay(bigQuery.DonePoll, beginSettleCts.Token);
                                }
                                catch (Google.GoogleApiException nf) when (!beginWasCreated && nf.HttpStatusCode == System.Net.HttpStatusCode.NotFound && !beginSettleCts.IsCancellationRequested)
                                {
                                    var rem = bigQuery.UnbornCancelLimit - beginUnbornWatch.Elapsed;
                                    if (rem <= TimeSpan.Zero) break;
                                    await Task.Delay(TimeSpan.FromTicks(Math.Min(bigQuery.UnbornCancelPoll.Ticks, rem.Ticks)), beginSettleCts.Token);
                                }
                            }
                        }
                        catch (Exception) { }
                    }
                }
                else if (wasSent && !wasVerified && (wasCreated || cancelledAtCatch || !BigQueryService.NeverCreated(error)))
                {
                    if (!wasComplete && Interlocked.Exchange(ref stopAsked, 1) == 0)
                        bigQuery.CancelJob(connection, project, jobId, curLocation, maybeUnborn: !wasCreated);
                    session.Tail = new BigQueryTail(jobId, curLocation, cancelled: !wasComplete, created: wasCreated || error is BigQueryJobMayExist { Exists: true });
                    try
                    {
                        using var settleCts = CancellationTokenSource.CreateLinkedTokenSource(bigQuery.Stopping);
                        settleCts.CancelAfter(wasCreated ? bigQuery.CloseWaitLimit : bigQuery.UnbornCancelLimit + bigQuery.CloseWaitLimit);
                        var settled = await bigQuery.SettleAsync(session, settleCts.Token, waitUnborn: !wasCreated);
                        if (settled.Done) jobSettledDone = true;
                        if (settled.SawCommit)
                        {
                            committedOrUnverified = true;
                        }
                        else if (!settled.ListingComplete)
                        {
                            committedOrUnverified = true;
                            unverifiedReason = true;
                        }
                    }
                    catch (Exception)
                    {
                        committedOrUnverified = true;
                        unverifiedReason = true;
                    }
                }
                if (session.Id is { } sid)
                    await bigQuery.AbortEphemeralSessionAsync(connection, sid, session.Location);
            }

            if (wasSent && wasCreated && jobSettledDone && !emittedDone)
            {
                emittedDone = true;
                target.Events.Job(SqlService.JobEvent(project, jobId, curLocation, "done",
                    session?.Transaction ?? BigQueryTransaction.None, target.Target.TargetKey));
            }

            if (!committedOrUnverified && jobFailed is not null)
                error = jobFailed;

            string status;
            MultiTargetError? targetError;
            var isCancellationError = IsCancellationError(error, timedOutAtCatch);
            if (committedOrUnverified)
            {
                status = "commitInDoubt";
                targetError = new("SQL_ERROR", unverifiedReason
                    ? "BigQuery did not confirm whether the stopped transaction job committed before interruption; outcome is unknown."
                    : "The stopped BigQuery job committed a transaction before it stopped; changes may already be committed.");
                target.Messages.Add(targetError.Message, MessageKind.Error, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
            }
            else if (cancelledAtCatch && isCancellationError)
            {
                StopJob();
                if (timedOutAtCatch)
                {
                    status = "timedOut";
                    targetError = new("TIMEOUT", "The query exceeded its execution timeout.");
                    target.Messages.Add(targetError.Message, MessageKind.Error, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                }
                else if (isTransaction && !userCancelledAtCatch)
                {
                    status = "rolledBack";
                    targetError = null;
                }
                else
                {
                    status = "cancelled";
                    targetError = new("CANCELLED", "Query execution was cancelled.");
                    target.Messages.Add(targetError.Message, MessageKind.Error, targetKey: target.Target.TargetKey, dialect: Providers.BigQuery);
                }
            }
            else
            {
                var mapped = await service.BigQueryFailureAsync(error, connection, wasCreated, cap, target.Prices != false, CancellationToken.None);
                status = error is BigQueryJobException && mapped.Code is "TIMEOUT" or "CANCELLED"
                    ? (mapped.Code == "TIMEOUT" ? "timedOut" : "cancelled")
                    : "failed";
                var text = SqlService.EditorPositions(mapped.Message, target.StartLine, target.StartColumn, out var line);
                target.Messages.Add(text, MessageKind.Error, line, target.Target.TargetKey, Providers.BigQuery);
                targetError = new(mapped.Code, MultiQueryCoordinator.ClampText(text, 16385), Line: line);
            }

            if (isTransaction && status != "commitInDoubt" && sets.Count > 0)
                MarkRolledBackPreview(sets, target.Events);

            var endedReason = status == "failed" ? "the run failed before its result set arrived"
                : status is "cancelled" or "timedOut" or "rolledBack" or "commitInDoubt" ? "the run stopped before its result set arrived" : null;
            FlushNameNotes(endedReason);

            EmitTargetState(target, status, 0, 1, recordsAffected, sets.Count, watch.ElapsedMilliseconds, summary?.BytesProcessed, targetError);
            var outcome = new MultiTargetOutcome(target.Target.TargetKey, Providers.BigQuery, target.Target.Label, status,
                0, 1, recordsAffected, watch.ElapsedMilliseconds, [.. sets.Select(s => s.ResultId)], target.Target.Environment,
                BytesProcessed: summary?.BytesProcessed, Job: summary ?? (wasCreated ? new BigQueryJobSummary(project, jobId, curLocation) : null), Error: targetError);
            return new(new MultiTargetPhase1Result(outcome, sets, NeedsCommit: false, discarded));
        }
        finally
        {
            watch.Stop();
            foreach (var set in sets.Where(s => s.IsOpen))
            {
                set.Complete();
                target.Events.Closed(set);
            }
            state.Residence.TargetCompleted();
            if (!leaseTransferred) lease.Dispose();
        }
    }

    private RunState GetOrCreateRunState(QueryBudget budget, int targetsCount) =>
        runs.GetValue(budget, _ => new RunState(targetsCount));

    private static int OffsetLine(int startLine, int relativeLine)
    {
        var line = (long)Math.Max(1, startLine) + Math.Max(1, relativeLine) - 1;
        return line > int.MaxValue ? int.MaxValue : (int)line;
    }

    private static long EstimateDescriptorBytes(IReadOnlyList<ResultColumn> columns) =>
        ColumnPlan.DescriptorBytesOf(columns);

    internal static bool IsCancellationError(Exception error, bool timedOut)
    {
        for (Exception? cur = error; cur is not null; cur = cur.InnerException)
        {
            if (cur is BigQueryJobMayExist or TimeoutException) return false;
            if (cur is OperationCanceledException oce) return oce.InnerException is not TimeoutException;
            if (cur is Grpc.Core.RpcException { StatusCode: Grpc.Core.StatusCode.Cancelled }) return true;
            if (cur is BigQueryJobException bqErr)
            {
                var serverTimedOut = bqErr.Result.Message?.Contains("timed out", StringComparison.OrdinalIgnoreCase) == true;
                if (bqErr.Errors.Append(bqErr.Result).Any(e =>
                    (e.Reason == "stopped" && (!serverTimedOut || timedOut))
                    || (e.Reason == "timeout" && timedOut)))
                    return true;
            }
        }
        return false;
    }

    private static void MarkRolledBackPreview(IReadOnlyList<ResultSetBuffer> sets, QueryEventSink events)
    {
        foreach (var set in sets)
        {
            if (set.RolledBackPreview) continue;
            set.RolledBackPreview = true;
            events.ResultSetMeta(set.ResultId, rolledBackPreview: true);
        }
    }

    private static void EmitTargetState(MultiTargetContext target, string phase, int batchesCompleted, int batchesTotal,
        long rowsAffected, int resultSetCount, long elapsedMs, long? bytesProcessed, MultiTargetError? error)
    {
        var clamped = error is null ? null : MultiQueryCoordinator.ClampError(error);
        target.Events.TargetState(new MultiQueryTargetStateEvent(
            target.Target.TargetKey, phase, batchesCompleted, batchesTotal, rowsAffected,
            resultSetCount, elapsedMs, bytesProcessed, clamped?.Code, clamped is null ? null : MultiQueryCoordinator.ClampText(clamped.Message, 2000)));
    }

    private static QueryArgs TargetQueryArgs(MultiTargetContext ctx, string? dataset, long? cap) => new(
        ConnectionId: ctx.Target.ConnectionId,
        SessionId: ctx.SessionId,
        Database: null,
        Sql: ctx.Sql,
        QueryId: ctx.QueryId,
        MaxRows: ctx.MaxRows,
        TimeoutSeconds: ctx.TimeoutSeconds,
        StartLine: ctx.StartLine,
        MaxResultSets: ctx.MaxResultSets,
        StopOnError: false,
        IncludeActualPlan: false,
        IncludeClientStatistics: false,
        IncludeLivePlan: false,
        DiscardResults: ctx.DiscardResults,
        Dataset: dataset,
        MaximumBytesBilled: cap,
        Prices: ctx.Prices,
        StartColumn: ctx.StartColumn,
        Residence: ctx.Residence,
        WindowCacheMiB: ctx.WindowCacheMiB,
        Preview: null,
        JobKey: ctx.JobKey,
        NoDefaultDataset: ctx.Target.NoDefaultDataset);

    private sealed class BigQueryPhase2Handle(
        BigQueryService bigQuery,
        BigQueryConnection connection,
        IDisposable lease,
        BigQueryTabSession session,
        IReadOnlyList<ResultSetBuffer> resultSets,
        QueryEventSink events,
        Func<bool> isAbandoned) : IMultiTargetPhase2Handle
    {
        private IDisposable? heldLease = lease;
        private int settled;

        public async Task<MultiCommitResult> CommitAsync(CancellationToken token)
        {
            if (Interlocked.Exchange(ref settled, 1) != 0)
                return new(MultiCommitOutcome.Refused, new MultiTargetError("INVALID_REQUEST", "The BigQuery target transaction was already settled."));
            if (isAbandoned())
            {
                MarkRolledBackPreview(resultSets, events);
                return new(MultiCommitOutcome.CancelledBeforeSend, new MultiTargetError("CANCELLED", "The query was abandoned during shutdown before commit was sent."));
            }
            if (session.Id is null) return new(MultiCommitOutcome.Committed);
            var result = await bigQuery.CommitEphemeralSessionAsync(session, token);
            if (result.Outcome is MultiCommitOutcome.Refused or MultiCommitOutcome.CancelledBeforeSend)
                MarkRolledBackPreview(resultSets, events);
            return result;
        }

        public async Task RollbackAsync(CancellationToken token)
        {
            if (Interlocked.Exchange(ref settled, 1) != 0) return;
            if (!isAbandoned())
            {
                if (session.Tail is { } tail)
                {
                    tail.Cancelled = true;
                    bigQuery.CancelJob(connection, connection.Options.Project, tail.JobId, tail.Location, maybeUnborn: !tail.Created);
                    try
                    {
                        using var settleCts = token.CanBeCanceled
                            ? CancellationTokenSource.CreateLinkedTokenSource(bigQuery.Stopping, token)
                            : CancellationTokenSource.CreateLinkedTokenSource(bigQuery.Stopping);
                        settleCts.CancelAfter(bigQuery.CloseWaitLimit);
                        await bigQuery.SettleAsync(session, settleCts.Token);
                    }
                    catch (Exception) { }
                }
                if (session.Id is { } sid)
                    await bigQuery.AbortEphemeralSessionAsync(connection, sid, session.Location, token);
            }
            MarkRolledBackPreview(resultSets, events);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref settled, 1) == 0 && session.Id is { } sid && !isAbandoned())
                await bigQuery.AbortEphemeralSessionAsync(connection, sid, session.Location);
            Interlocked.Exchange(ref heldLease, null)?.Dispose();
        }
    }
}

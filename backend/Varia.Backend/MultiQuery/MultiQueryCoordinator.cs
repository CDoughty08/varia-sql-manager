using System.Diagnostics;
using System.Globalization;
using System.Text;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.MultiQuery;

/// <summary>Coordinates multi-server and cross-engine query runs across providers: enforces the shared per-session
/// active-run gate, global concurrency cap (max 8), RunningQuery registration, single ResultStore.BeginQuery / QueryBudget,
/// shared MultiQueryQuota, Pre-flight -> Phase 1 -> Phase 2 (Commit or Rollback) barrier, and optional post-Phase-2 autoCombine.</summary>
internal sealed class MultiQueryCoordinator(
    SqlService service,
    IReadOnlyDictionary<string, IMultiTargetRunner> runners,
    IResultCombiner? combiner = null,
    IReadOnlySqlValidator? sqlValidator = null,
    Func<string, string?>? providerOf = null,
    Func<IReadOnlyList<MultiTargetContext>, CancellationToken, Task<IReadOnlyList<MultiTargetPreflightOutcome>>>? crossEnginePreflight = null) : IMultiQueryCoordinator
{
    internal const int MaxConcurrentRuns = 8;
    internal const int MaxTargetParallelism = 8;
    internal const int DefaultTransactionTimeoutSeconds = 300;
    internal const int CommitTimeoutSeconds = 30;
    internal const int RollbackTimeoutSeconds = 10;

    private readonly IReadOnlySqlValidator readOnlyValidator = sqlValidator ?? new ReadOnlySqlValidator();
    private readonly Func<string, string?> resolveProvider = providerOf ?? service.LiveProvider;
    private int activeRuns;

    internal int ActiveRuns => Volatile.Read(ref activeRuns);

    public async Task<QueryMultiResult> ExecuteAsync(QueryMultiArgs args, RequestContext? context)
    {
        var currentActive = Interlocked.Increment(ref activeRuns);
        if (currentActive > MaxConcurrentRuns)
        {
            Interlocked.Decrement(ref activeRuns);
            throw new RequestException("SESSION_LIMIT",
                $"At most {MaxConcurrentRuns.ToString(CultureInfo.InvariantCulture)} multi-server queries can run concurrently.");
        }

        var sessionEntered = false;
        var queryRegistered = false;
        SqlService.RunningQuery? running = null;
        QueryBudget? budget = null;
        CancellationTokenSource? userCancelCts = null;
        CancellationTokenSource? timeoutCts = null;
        CancellationTokenSource? cancellation = null;
        CancellationTokenRegistration contextReg = default;
        var watch = Stopwatch.StartNew();

        try
        {
            // Resolve each target's provider and ensure a runner is registered before claiming session state.
            var providers = new string[args.Targets.Length];
            var hasBigQuery = false;
            var connectionIds = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < args.Targets.Length; i++)
            {
                var target = args.Targets[i];
                var provider = resolveProvider(target.ConnectionId);
                if (provider is null)
                    throw new RequestException("NOT_CONNECTED", "Connect to each target server first.");
                if (!runners.ContainsKey(provider))
                    throw new RequestException("UNSUPPORTED_PROVIDER", $"No multi-server runner is registered for provider '{provider}'.");
                providers[i] = provider;
                if (provider == Providers.BigQuery) hasBigQuery = true;
                connectionIds.Add(target.ConnectionId);
            }

            sessionEntered = service.TryBeginSessionRun(args.SessionId, args.QueryId);
            if (!sessionEntered)
                throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");

            var requestedTimeout = args.TimeoutSeconds ?? 0;
            var effectiveTimeoutSeconds = requestedTimeout > 0
                ? requestedTimeout
                : args.Mode == "transaction" ? DefaultTransactionTimeoutSeconds : 0;

            userCancelCts = new CancellationTokenSource();
            timeoutCts = effectiveTimeoutSeconds > 0
                ? new CancellationTokenSource(TimeSpan.FromSeconds(effectiveTimeoutSeconds))
                : new CancellationTokenSource();
            cancellation = CancellationTokenSource.CreateLinkedTokenSource(userCancelCts.Token, timeoutCts.Token);

            running = new SqlService.RunningQuery(connectionIds, args.SessionId, userCancelCts)
            {
                Detachable = false,
                AbandonBigQueryOnShutdown = hasBigQuery
            };

            if (!service.Register(args.QueryId, running))
                throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
            queryRegistered = true;

            // Re-verify every target connection is still live AFTER Register() to close the disconnect TOCTOU window.
            for (var i = 0; i < args.Targets.Length; i++)
            {
                var currentProvider = resolveProvider(args.Targets[i].ConnectionId);
                if (currentProvider is null || currentProvider != providers[i])
                    throw new RequestException("NOT_CONNECTED", "Connect to each target server first.");
            }

            if (context is not null)
            {
                var localRunning = running;
                var localTimeoutCts = timeoutCts;
                contextReg = context.Token.Register(() =>
                {
                    if (context.Reason == CancelReason.Deadline) TryCancel(localTimeoutCts);
                    else localRunning.Cancel();
                });
            }

            // Single ResultStore.BeginQuery for the entire multi-server run, with budget.Executing held throughout.
            budget = service.Results.BeginQuery(args.SessionId);
            budget.Executing = true;

            var quota = new MultiQueryQuota(args.MaxResultSets, SqlService.MaxSummaryDescriptorBytes);
            using var events = new QueryEventSink(context is null ? null : context.SendEvent);
            var messages = new QueryMessages(events.Message);
            var token = cancellation.Token;

            var contexts = BuildTargetContexts(args, providers, effectiveTimeoutSeconds, quota, running, cancellation, budget, messages, events);

            // Handle early cancellation (e.g., query.cancel arrived before registration).
            if (token.IsCancellationRequested)
            {
                var cancelStatus = running.UserCancelled ? "cancelled" : "timedOut";
                var cancelCode = running.UserCancelled ? "CANCELLED" : "TIMEOUT";
                var cancelMessage = running.UserCancelled ? "The query was cancelled." : "The query exceeded its execution timeout.";
                var earlyOutcomes = new List<MultiTargetOutcome>(contexts.Length);
                foreach (var ctx in contexts)
                {
                    var err = new MultiTargetError(cancelCode, cancelMessage);
                    events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, cancelStatus, 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: err.Code, ErrorMessage: err.Message));
                    earlyOutcomes.Add(EmptyOutcome(ctx, cancelStatus, watch.ElapsedMilliseconds, err));
                }
                messages.Add(cancelMessage, MessageKind.Error);
                return FinalizeResult(args.Mode, cancelStatus, earlyOutcomes, [], quota, budget, messages, watch, combineWarnings: null);
            }

            // Stage 1: Pre-flight.
            foreach (var ctx in contexts)
                events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, "preflight", 0, 0, 0, 0, watch.ElapsedMilliseconds));

            var preflightFailure = await RunPreflightAsync(args, contexts, running, messages, events, watch, token).ConfigureAwait(false);
            if (preflightFailure is not null)
            {
                return FinalizeResult(args.Mode, preflightFailure.Status, preflightFailure.Outcomes, [], quota, budget, messages, watch, combineWarnings: null);
            }

            // Stage 2: Phase 1 execution.
            var isTransaction = args.Mode == "transaction";
            var isSequential = args.Mode == "fireAndForget" && args.Sequential == true;
            var phase1Outcomes = new MultiTargetPhase1Outcome?[contexts.Length];

            using var phase1Cts = CancellationTokenSource.CreateLinkedTokenSource(token);

            if (isSequential)
            {
                var stopped = false;
                for (var i = 0; i < contexts.Length; i++)
                {
                    var ctx = contexts[i];
                    if (stopped || phase1Cts.IsCancellationRequested)
                    {
                        var skipStatus = phase1Cts.IsCancellationRequested
                            ? (running.UserCancelled ? "cancelled" : "timedOut")
                            : "skipped";
                        MultiTargetError? skipErr = skipStatus == "skipped"
                            ? null
                            : new MultiTargetError(skipStatus == "cancelled" ? "CANCELLED" : "TIMEOUT",
                                skipStatus == "cancelled" ? "The query was cancelled." : "The query exceeded its execution timeout.");
                        if (skipErr is not null)
                            messages.Add(skipErr.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
                        events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, skipStatus, 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: skipErr?.Code, ErrorMessage: skipErr?.Message));
                        phase1Outcomes[i] = new MultiTargetPhase1Outcome(
                            new MultiTargetPhase1Result(EmptyOutcome(ctx, skipStatus, 0, skipErr), [], NeedsCommit: false));
                        continue;
                    }

                    var outcome = await ExecuteTargetSafelyAsync(runners[ctx.Provider], ctx, phase1Cts.Token).ConfigureAwait(false);
                    if (outcome.Phase2 is not null) await DisposeQuietlyAsync(outcome.Phase2).ConfigureAwait(false);
                    outcome = outcome with { Phase2 = null };
                    phase1Outcomes[i] = outcome;

                    var st = outcome.Result.Outcome.Status;
                    if (st is "failed" or "cancelled" or "timedOut" or "commitInDoubt" || outcome.Result.Outcome.Error is not null)
                    {
                        stopped = true;
                    }
                }
            }
            else
            {
                using var throttle = new SemaphoreSlim(Math.Min(contexts.Length, MaxTargetParallelism));
                var tasks = new Task[contexts.Length];
                for (var i = 0; i < contexts.Length; i++)
                {
                    var index = i;
                    var ctx = contexts[i];
                    var runner = runners[ctx.Provider];
                    tasks[i] = Task.Run(async () =>
                    {
                        var acquired = false;
                        try
                        {
                            await throttle.WaitAsync(phase1Cts.Token).ConfigureAwait(false);
                            acquired = true;
                        }
                        catch (OperationCanceledException)
                        {
                            var unstartedStatus = running.UserCancelled
                                ? "cancelled"
                                : cancellation.IsCancellationRequested
                                    ? "timedOut"
                                    : "skipped";
                            MultiTargetError? unstartedError = unstartedStatus switch
                            {
                                "cancelled" => new MultiTargetError("CANCELLED", "The query was cancelled."),
                                "timedOut" => new MultiTargetError("TIMEOUT", "The query exceeded its execution timeout."),
                                _ => null
                            };
                            if (unstartedError is not null)
                                messages.Add(unstartedError.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
                            events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, unstartedStatus, 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: unstartedError?.Code, ErrorMessage: unstartedError?.Message));
                            phase1Outcomes[index] = new MultiTargetPhase1Outcome(
                                new MultiTargetPhase1Result(EmptyOutcome(ctx, unstartedStatus, 0, unstartedError), [], NeedsCommit: false));
                            return;
                        }

                        try
                        {
                            var outcome = await ExecuteTargetSafelyAsync(runner, ctx, phase1Cts.Token).ConfigureAwait(false);
                            phase1Outcomes[index] = outcome;

                            if (isTransaction)
                            {
                                var passed = outcome.Result.NeedsCommit && outcome.Phase2 is not null && outcome.Result.Outcome.Status == "succeeded";
                                if (!passed)
                                {
                                    TryCancel(phase1Cts);
                                }
                            }
                        }
                        finally
                        {
                            if (acquired) throttle.Release();
                        }
                    });
                }

                await Task.WhenAll(tasks).ConfigureAwait(false);
            }

            // Stage 3: Phase 2 (Commit or Rollback for Transaction mode; cleanup + timeout classification for all modes).
            var finalOutcomes = new MultiTargetOutcome[contexts.Length];
            var targetResultSets = new IReadOnlyList<ResultSetBuffer>[contexts.Length];
            for (var i = 0; i < contexts.Length; i++)
            {
                var entry = phase1Outcomes[i] ?? new MultiTargetPhase1Outcome(
                    new MultiTargetPhase1Result(EmptyOutcome(contexts[i], "failed", 0, new MultiTargetError("BACKEND_ERROR", "Target produced no Phase 1 outcome.")), [], NeedsCommit: false));
                finalOutcomes[i] = entry.Result.Outcome;
                targetResultSets[i] = entry.Result.ResultSets;
            }

            var enteredPhase2Commit = false;
            if (isTransaction)
            {
                var allPassed = !token.IsCancellationRequested && !running.UserCancelled && !running.Abandoned;
                if (allPassed)
                {
                    for (var i = 0; i < contexts.Length; i++)
                    {
                        var entry = phase1Outcomes[i];
                        if (entry is null || !entry.Result.NeedsCommit || entry.Phase2 is null || entry.Result.Outcome.Status != "succeeded")
                        {
                            allPassed = false;
                            break;
                        }
                    }
                }

                if (allPassed)
                {
                    enteredPhase2Commit = true;
                    // Phase 2 Commit uses userCancelCts + a fresh bounded CommitTimeoutSeconds so an expiring Phase 1 timer
                    // cannot mid-flight abort COMMIT after every target already cleared the barrier.
                    using var commitCts = CancellationTokenSource.CreateLinkedTokenSource(userCancelCts.Token);
                    commitCts.CancelAfter(TimeSpan.FromSeconds(CommitTimeoutSeconds));
                    var commitToken = commitCts.Token;
                    var commitTasks = new Task[contexts.Length];
                    for (var i = 0; i < contexts.Length; i++)
                    {
                        var index = i;
                        var ctx = contexts[i];
                        var handle = phase1Outcomes[i]!.Phase2!;
                        var current = finalOutcomes[i];
                        commitTasks[i] = Task.Run(async () =>
                        {
                            MultiCommitResult commitResult;
                            try
                            {
                                events.TargetState(new MultiQueryTargetStateEvent(
                                    ctx.Target.TargetKey, "committing", current.BatchesCompleted, current.BatchesTotal,
                                    current.RowsAffected, current.ResultSetIds.Count, watch.ElapsedMilliseconds, current.BytesProcessed));
                                commitResult = await handle.CommitAsync(commitToken).ConfigureAwait(false);
                            }
                            catch (Exception error)
                            {
                                commitResult = new MultiCommitResult(
                                    MultiCommitOutcome.InDoubt,
                                    new MultiTargetError("BACKEND_ERROR", "Commit failed unexpectedly; outcome is in doubt. " + error.Message));
                            }
                            finally
                            {
                                await DisposeQuietlyAsync(handle).ConfigureAwait(false);
                            }

                            if (commitResult.Outcome is MultiCommitOutcome.Refused or MultiCommitOutcome.CancelledBeforeSend)
                                SqlServerMultiRunner.MarkRolledBackPreview(targetResultSets[index], events);

                            var timedOutBeforeSend = commitResult.Outcome == MultiCommitOutcome.CancelledBeforeSend
                                && (string.Equals(commitResult.Error?.Code, "TIMEOUT", StringComparison.Ordinal) || !running.UserCancelled);
                            var committedStatus = commitResult.Outcome switch
                            {
                                MultiCommitOutcome.Committed => "committed",
                                MultiCommitOutcome.Refused => "failed",
                                MultiCommitOutcome.CancelledBeforeSend => timedOutBeforeSend ? "timedOut" : "cancelled",
                                _ => "commitInDoubt"
                            };
                            MultiTargetError? committedError = commitResult.Outcome switch
                            {
                                MultiCommitOutcome.Committed => null,
                                MultiCommitOutcome.CancelledBeforeSend when timedOutBeforeSend => new MultiTargetError("TIMEOUT", "The query exceeded its execution timeout before commit was sent."),
                                MultiCommitOutcome.CancelledBeforeSend => new MultiTargetError("CANCELLED", commitResult.Error?.Message ?? "The transaction commit was cancelled before it was sent."),
                                _ => commitResult.Error is { } err ? ClampError(err) : null
                            };
                            if (committedError is not null)
                                messages.Add(committedError.Message, MessageKind.Error, committedError.Line, ctx.Target.TargetKey, ctx.Provider);

                            var updated = current with { Status = committedStatus, Error = committedError };
                            finalOutcomes[index] = updated;
                            events.TargetState(new MultiQueryTargetStateEvent(
                                ctx.Target.TargetKey, committedStatus, updated.BatchesCompleted, updated.BatchesTotal,
                                updated.RowsAffected, updated.ResultSetIds.Count, watch.ElapsedMilliseconds,
                                updated.BytesProcessed, committedError?.Code, ClampEventMessage(committedError?.Message)));
                        });
                    }

                    await Task.WhenAll(commitTasks).ConfigureAwait(false);
                }
                else
                {
                    // Rollback branch: always use a fresh bounded 10 s token (never the cancelled Phase 1 token).
                    using var rollbackCts = new CancellationTokenSource(TimeSpan.FromSeconds(RollbackTimeoutSeconds));
                    var rollbackToken = rollbackCts.Token;
                    var rollbackTasks = new List<Task>();

                    for (var i = 0; i < contexts.Length; i++)
                    {
                        var index = i;
                        var ctx = contexts[i];
                        var entry = phase1Outcomes[i];
                        var current = finalOutcomes[i];
                        if (entry?.Phase2 is { } handle)
                        {
                            rollbackTasks.Add(Task.Run(async () =>
                            {
                                try
                                {
                                    events.TargetState(new MultiQueryTargetStateEvent(
                                        ctx.Target.TargetKey, "rollingBack", current.BatchesCompleted, current.BatchesTotal,
                                        current.RowsAffected, current.ResultSetIds.Count, watch.ElapsedMilliseconds, current.BytesProcessed));
                                    await handle.RollbackAsync(rollbackToken).ConfigureAwait(false);
                                }
                                catch (Exception)
                                {
                                    // Disposing the handle in finally closes the ephemeral connection/session.
                                }
                                finally
                                {
                                    await DisposeQuietlyAsync(handle).ConfigureAwait(false);
                                }

                                SqlServerMultiRunner.MarkRolledBackPreview(targetResultSets[index], events);
                                var updated = current with { Status = "rolledBack", Error = null };
                                finalOutcomes[index] = updated;
                                events.TargetState(new MultiQueryTargetStateEvent(
                                    ctx.Target.TargetKey, "rolledBack", updated.BatchesCompleted, updated.BatchesTotal,
                                    updated.RowsAffected, updated.ResultSetIds.Count, watch.ElapsedMilliseconds, updated.BytesProcessed));
                            }));
                        }
                        else
                        {
                            if (current.Status != "commitInDoubt")
                                SqlServerMultiRunner.MarkRolledBackPreview(targetResultSets[index], events);
                        }
                    }

                    if (rollbackTasks.Count > 0) await Task.WhenAll(rollbackTasks).ConfigureAwait(false);
                }
            }
            else
            {
                // Non-transaction modes: dispose any unexpected Phase 2 handle.
                // Runners (and ExecuteTargetSafelyAsync) already classify timeout/user-cancel via ctx.IsTimedOut / ctx.IsUserCancelled
                // before emitting their single terminal event, so Stage 3 never rewrites external cancellations or double-emits.
                for (var i = 0; i < contexts.Length; i++)
                {
                    if (phase1Outcomes[i]?.Phase2 is { } stray)
                        await DisposeQuietlyAsync(stray).ConfigureAwait(false);
                }
            }

            // Collect all stored result sets in target order and ensure none remain open.
            var allSets = new List<ResultSetBuffer>();
            for (var i = 0; i < contexts.Length; i++)
            {
                foreach (var set in targetResultSets[i])
                {
                    if (set.IsOpen)
                    {
                        set.Complete();
                        events.Closed(set);
                    }
                    allSets.Add(set);
                }
            }

            // Stage 4: Optional post-Phase-2 autoCombine (only after Phase 2 has settled).
            // Once Phase 2 Commit was entered, decouple autoCombine from the Phase 1 timeout timer so an expiring
            // Phase 1 timer during commit cannot silently suppress autoCombine on a completed run.
            List<string>? combineWarnings = null;
            var combineToken = enteredPhase2Commit ? userCancelCts.Token : token;
            if (args.AutoCombine != false && combiner is not null && !combineToken.IsCancellationRequested && !running.UserCancelled)
            {
                var commitInDoubtKeys = new HashSet<string>(
                    finalOutcomes.Where(o => o.Status == "commitInDoubt").Select(o => o.TargetKey),
                    StringComparer.Ordinal);
                combineWarnings = await RunAutoCombineAsync(allSets, commitInDoubtKeys, budget, quota, events, combineToken).ConfigureAwait(false);
            }

            // Main owns the stored result sets only once the response frame is sent; release all of them if framing fails.
            if (context is not null && allSets.Count > 0)
            {
                var idsToRelease = allSets.Select(s => s.ResultId).ToArray();
                context.Unsent = () => service.Results.Release(idsToRelease);
            }

            var overallStatus = ComputeOverallStatus(args.Mode, finalOutcomes, running);
            return FinalizeResult(args.Mode, overallStatus, [.. finalOutcomes], allSets, quota, budget, messages, watch, combineWarnings);
        }
        finally
        {
            watch.Stop();
            if (budget is not null) budget.Executing = false;
            contextReg.Dispose();
            if (queryRegistered && running is not null)
                service.UnregisterQuery(args.QueryId, running);
            cancellation?.Dispose();
            timeoutCts?.Dispose();
            userCancelCts?.Dispose();
            if (sessionEntered) service.EndSessionRun(args.SessionId, args.QueryId);
            Interlocked.Decrement(ref activeRuns);
            if (queryRegistered && running is not null)
                running.Ended.TrySetResult();
        }
    }

    private MultiTargetContext[] BuildTargetContexts(
        QueryMultiArgs args,
        string[] providers,
        int effectiveTimeoutSeconds,
        IMultiQueryQuota quota,
        SqlService.RunningQuery running,
        CancellationTokenSource outerCancellation,
        QueryBudget budget,
        QueryMessages messages,
        QueryEventSink events)
    {
        var contexts = new MultiTargetContext[args.Targets.Length];
        var isCross = args.Mode == "crossEngineReadOnly";
        var maxRows = args.MaxRows ?? 0;
        var stopOnError = args.StopOnError ?? false;
        var discardResults = args.DiscardResults ?? false;
        var preflightDryRun = args.PreflightDryRun ?? false;
        Func<bool> isAbandoned = () => running.Abandoned;
        Func<bool> isUserCancelled = () => running.UserCancelled;
        Func<bool> isTimedOut = () => !running.UserCancelled && outerCancellation.IsCancellationRequested;

        for (var i = 0; i < args.Targets.Length; i++)
        {
            var target = args.Targets[i];
            var provider = providers[i];
            string sql;
            int startLine;
            int startColumn;
            if (isCross)
            {
                if (provider == Providers.BigQuery)
                {
                    sql = args.Scripts!.Bigquery;
                    startLine = args.StartLines?.Bigquery ?? 1;
                }
                else
                {
                    sql = args.Scripts!.Sqlserver;
                    startLine = args.StartLines?.Sqlserver ?? 1;
                }
                startColumn = 1;
            }
            else
            {
                sql = args.Sql!;
                startLine = args.StartLine ?? 1;
                startColumn = args.StartColumn ?? 1;
            }

            contexts[i] = new MultiTargetContext(
                args.QueryId,
                args.SessionId,
                args.Mode,
                preflightDryRun,
                target,
                provider,
                sql,
                startLine,
                startColumn,
                maxRows,
                args.MaxResultSets,
                effectiveTimeoutSeconds,
                stopOnError,
                discardResults,
                args.Prices,
                args.Residence,
                args.WindowCacheMiB,
                args.JobKey,
                quota,
                isAbandoned,
                budget,
                messages,
                events,
                isUserCancelled,
                isTimedOut);
        }

        return contexts;
    }

    private sealed record PreflightFailure(string Status, List<MultiTargetOutcome> Outcomes);

    private async Task<PreflightFailure?> RunPreflightAsync(
        QueryMultiArgs args,
        MultiTargetContext[] contexts,
        SqlService.RunningQuery running,
        QueryMessages messages,
        QueryEventSink events,
        Stopwatch watch,
        CancellationToken token)
    {
        var failures = new Dictionary<string, MultiTargetError>(StringComparer.Ordinal);

        if (args.Mode == "crossEngineReadOnly")
        {
            var sqlStartLine = args.StartLines?.Sqlserver ?? 1;
            IReadOnlyList<ReadOnlySqlViolation> violations;
            try
            {
                violations = await readOnlyValidator.ValidateTSqlAsync(args.Scripts!.Sqlserver, sqlStartLine, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return BuildCancelledPreflight(contexts, running, messages, events, watch);
            }

            if (violations.Count > 0)
            {
                var first = violations[0];
                var readOnlyErr = ClampError(new MultiTargetError("READ_ONLY_VIOLATION", first.Message, Line: first.Line));
                foreach (var ctx in contexts)
                {
                    if (ctx.Provider == Providers.SqlServer)
                    {
                        foreach (var violation in violations)
                            messages.Add(violation.Message, MessageKind.Error, violation.Line, ctx.Target.TargetKey, Providers.SqlServer);
                        failures[ctx.Target.TargetKey] = readOnlyErr;
                    }
                }
                return BuildFailedPreflight(contexts, failures, messages, events, watch, messagesAlreadyLogged: true);
            }

            // Mark SQL Server targets as validated so SqlServerMultiRunner does not spawn additional 256 MiB ScriptDom parse threads.
            for (var i = 0; i < contexts.Length; i++)
            {
                if (contexts[i].Provider == Providers.SqlServer)
                    contexts[i] = contexts[i] with { ReadOnlyValidated = true };
            }
        }

        if (args.Mode == "crossEngineReadOnly" && crossEnginePreflight is not null)
        {
            IReadOnlyList<MultiTargetPreflightOutcome> crossOutcomes;
            try
            {
                crossOutcomes = await crossEnginePreflight(contexts, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return BuildCancelledPreflight(contexts, running, messages, events, watch);
            }

            foreach (var item in crossOutcomes)
            {
                if (!item.Passed)
                    failures[item.TargetKey] = ClampError(item.Error ?? new MultiTargetError("READ_ONLY_VIOLATION", "Cross-engine pre-flight check failed."));
            }
            if (failures.Count > 0)
                return BuildFailedPreflight(contexts, failures, messages, events, watch, messagesAlreadyLogged: false);
        }

        // Run per-provider runner pre-flight checks.
        var byProvider = contexts.GroupBy(c => c.Provider, StringComparer.Ordinal);
        foreach (var group in byProvider)
        {
            var providerContexts = group.ToList();
            IReadOnlyList<MultiTargetPreflightOutcome> preflightResults;
            try
            {
                preflightResults = await runners[group.Key].PreflightAsync(providerContexts, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return BuildCancelledPreflight(contexts, running, messages, events, watch);
            }
            catch (RequestException error)
            {
                var err = ClampError(new MultiTargetError(error.Code, error.Message));
                foreach (var ctx in providerContexts) failures[ctx.Target.TargetKey] = err;
                continue;
            }

            foreach (var outcome in preflightResults)
            {
                if (!outcome.Passed)
                    failures[outcome.TargetKey] = ClampError(outcome.Error ?? new MultiTargetError("INVALID_SCRIPT", "Pre-flight validation failed."));
            }
        }

        if (failures.Count > 0)
            return BuildFailedPreflight(contexts, failures, messages, events, watch, messagesAlreadyLogged: false);

        return null;
    }

    private static PreflightFailure BuildFailedPreflight(
        MultiTargetContext[] contexts,
        Dictionary<string, MultiTargetError> failures,
        QueryMessages messages,
        QueryEventSink events,
        Stopwatch watch,
        bool messagesAlreadyLogged)
    {
        var outcomes = new List<MultiTargetOutcome>(contexts.Length);
        foreach (var ctx in contexts)
        {
            if (failures.TryGetValue(ctx.Target.TargetKey, out var err))
            {
                var clamped = ClampError(err);
                if (!messagesAlreadyLogged)
                    messages.Add(clamped.Message, MessageKind.Error, clamped.Line, ctx.Target.TargetKey, ctx.Provider);
                events.TargetState(new MultiQueryTargetStateEvent(
                    ctx.Target.TargetKey, "failed", 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: clamped.Code, ErrorMessage: ClampEventMessage(clamped.Message)));
                outcomes.Add(EmptyOutcome(ctx, "failed", watch.ElapsedMilliseconds, clamped));
            }
            else
            {
                events.TargetState(new MultiQueryTargetStateEvent(
                    ctx.Target.TargetKey, "skipped", 0, 0, 0, 0, watch.ElapsedMilliseconds));
                outcomes.Add(EmptyOutcome(ctx, "skipped", 0, null));
            }
        }
        return new PreflightFailure("failed", outcomes);
    }

    private static PreflightFailure BuildCancelledPreflight(
        MultiTargetContext[] contexts,
        SqlService.RunningQuery running,
        QueryMessages messages,
        QueryEventSink events,
        Stopwatch watch)
    {
        var status = running.UserCancelled ? "cancelled" : "timedOut";
        var err = running.UserCancelled
            ? new MultiTargetError("CANCELLED", "The query was cancelled during pre-flight.")
            : new MultiTargetError("TIMEOUT", "The query exceeded its execution timeout during pre-flight.");
        messages.Add(err.Message, MessageKind.Error);
        var outcomes = new List<MultiTargetOutcome>(contexts.Length);
        foreach (var ctx in contexts)
        {
            events.TargetState(new MultiQueryTargetStateEvent(
                ctx.Target.TargetKey, status, 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: err.Code, ErrorMessage: ClampEventMessage(err.Message)));
            outcomes.Add(EmptyOutcome(ctx, status, watch.ElapsedMilliseconds, err));
        }
        return new PreflightFailure(status, outcomes);
    }

    private static async Task<MultiTargetPhase1Outcome> ExecuteTargetSafelyAsync(IMultiTargetRunner runner, MultiTargetContext ctx, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            return await runner.ExecutePhase1Async(ctx, token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            watch.Stop();
            string status;
            MultiTargetError? err;
            if (ctx.IsTimedOut?.Invoke() == true)
            {
                status = "timedOut";
                err = new MultiTargetError("TIMEOUT", "The query exceeded its execution timeout.");
                ctx.Messages.Add(err.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
            }
            else if (ctx.Mode == "transaction" && ctx.IsUserCancelled?.Invoke() == false)
            {
                status = "rolledBack";
                err = null;
            }
            else
            {
                status = "cancelled";
                err = new MultiTargetError("CANCELLED", "The query was cancelled.");
                ctx.Messages.Add(err.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
            }
            ctx.Events.TargetState(new MultiQueryTargetStateEvent(
                ctx.Target.TargetKey, status, 0, 0, 0, 0, watch.ElapsedMilliseconds, ErrorCode: err?.Code, ErrorMessage: ClampEventMessage(err?.Message)));
            return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(EmptyOutcome(ctx, status, watch.ElapsedMilliseconds, err), [], NeedsCommit: false));
        }
        catch (RequestException error)
        {
            var err = ClampError(new MultiTargetError(error.Code, error.Message));
            ctx.Messages.Add(err.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
            ctx.Events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, "failed", 0, 0, 0, 0, 0, ErrorCode: err.Code, ErrorMessage: ClampEventMessage(err.Message)));
            return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(EmptyOutcome(ctx, "failed", 0, err), [], NeedsCommit: false));
        }
        catch (Exception error)
        {
            var msg = "Execution stopped unexpectedly: " + error.Message;
            var err = ClampError(new MultiTargetError("BACKEND_ERROR", msg));
            ctx.Messages.Add(err.Message, MessageKind.Error, targetKey: ctx.Target.TargetKey, dialect: ctx.Provider);
            ctx.Events.TargetState(new MultiQueryTargetStateEvent(ctx.Target.TargetKey, "failed", 0, 0, 0, 0, 0, ErrorCode: err.Code, ErrorMessage: ClampEventMessage(err.Message)));
            return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(EmptyOutcome(ctx, "failed", 0, err), [], NeedsCommit: false));
        }
    }

    private async Task<List<string>?> RunAutoCombineAsync(
        List<ResultSetBuffer> allSets,
        HashSet<string> commitInDoubtKeys,
        QueryBudget budget,
        IMultiQueryQuota quota,
        QueryEventSink events,
        CancellationToken token)
    {
        if (combiner is null) return null;

        var bySlot = new SortedDictionary<int, List<ResultSetBuffer>>();
        foreach (var set in allSets)
        {
            if (set.Kind != "rows" || !set.IsComplete || set.IsReleased || set.StatementSlot is not { } slot)
                continue;
            if (!bySlot.TryGetValue(slot, out var group))
            {
                group = [];
                bySlot[slot] = group;
            }
            group.Add(set);
        }

        List<string>? warnings = null;
        foreach (var (slot, sources) in bySlot)
        {
            if (sources.Count < 2) continue;
            if (token.IsCancellationRequested) break;

            var hasCommitInDoubt = sources.Any(s => !s.IsRemote && s.TargetKey is { } key && commitInDoubtKeys.Contains(key));
            var hasRolledBack = sources.Any(s => !s.IsRemote && s.RolledBackPreview);
            var hasCommittedOrLive = sources.Any(s => !s.IsRemote && !s.RolledBackPreview);
            if (hasCommitInDoubt || (hasRolledBack && hasCommittedOrLive))
            {
                (warnings ??= []).Add($"Combined view for statement {slot + 1} was skipped because targets had mixed transaction outcomes (committed or commit-in-doubt alongside rolled-back results).");
                continue;
            }

            var statementName = sources.Select(s => s.ResultName).FirstOrDefault(n => n is not null);
            var estimatedBytes = EstimateCombinedDescriptorBytes(sources, statementName);
            if (!quota.TryAllocate(estimatedBytes, out var combinedIndex, out _))
            {
                (warnings ??= []).Add($"Combined view for statement {slot + 1} was skipped because the result set or descriptor limit was reached.");
                continue;
            }

            CombineOutput output;
            try
            {
                output = await combiner.CombineAsync(
                    service.Results,
                    budget,
                    sources,
                    combinedIndex,
                    sources[0].BatchNumber,
                    sources[0].Iteration,
                    statementName,
                    throwOnBudgetRefusal: false,
                    token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                quota.Release(combinedIndex, estimatedBytes);
                break;
            }
            catch (Exception)
            {
                quota.Release(combinedIndex, estimatedBytes);
                (warnings ??= []).Add($"Combined view for statement {slot + 1} could not be built.");
                continue;
            }

            if (output.Warnings.Count > 0)
            {
                warnings ??= [];
                warnings.AddRange(output.Warnings);
            }

            if (output.Buffer is { } combined)
            {
                if (sources.Any(s => !s.IsRemote && s.RolledBackPreview)) combined.RolledBackPreview = true;
                if (sources.Any(s => !s.IsRemote && s.Incomplete)) combined.Incomplete = true;
                if (combined.IsOpen) combined.Complete();
                events.Opened(combined);
                events.Closed(combined);
                allSets.Add(combined);
            }
            else
            {
                quota.Release(combinedIndex, estimatedBytes);
            }
        }

        return warnings;
    }

    internal static long EstimateCombinedDescriptorBytes(IReadOnlyList<ResultSetBuffer> sources, string? statementName = null)
    {
        // Sum the max per-column descriptor cost for each distinct aligned column slot (capped at PageBuilder.MaxColumns),
        // matching ColumnPlan.DescriptorBytesOf (names + widened dataType + collation + 120/184 overhead + 512 base).
        var slotCost = new Dictionary<(string Key, int Occurrence), long>();
        foreach (var set in sources)
        {
            if (set.IsRemote) continue;
            var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var col in set.Columns)
            {
                if (ResultTextWriter.Hidden(col)) continue;
                var key = OrdinalNames.KeyOf(col.Name);
                occurrences.TryGetValue(key, out var occ);
                occurrences[key] = occ + 1;
                var alignKey = (key, occ);
                var dataTypeBytes = Math.Max(Encoding.UTF8.GetByteCount(col.DataType), 16);
                var cost = Encoding.UTF8.GetByteCount(col.Name) + dataTypeBytes + (col.Collation is null ? 120L : 184L);
                if (slotCost.TryGetValue(alignKey, out var existing))
                {
                    if (cost > existing) slotCost[alignKey] = cost;
                }
                else if (slotCost.Count + 1 < PageBuilder.MaxColumns)
                {
                    slotCost[alignKey] = cost;
                }
            }
        }
        // Include base 512 + synthetic _server column + statementName bytes.
        var total = 512L + 160L + (statementName is null ? 0L : Encoding.UTF8.GetByteCount(statementName) + 8L);
        foreach (var cost in slotCost.Values) total += cost;
        return total;
    }

    internal static string ComputeOverallStatus(string mode, IReadOnlyList<MultiTargetOutcome> outcomes, SqlService.RunningQuery running)
    {
        if (outcomes.Any(o => o.Status == "commitInDoubt")) return "commitInDoubt";

        if (mode == "transaction")
        {
            if (outcomes.Count > 0 && outcomes.All(o => o.Status == "committed")) return "completed";
            if (outcomes.Any(o => o.Status == "committed")) return "partialFailure";
            if (outcomes.Any(o => o.Status == "rolledBack")) return "rolledBack";
            if (outcomes.Any(o => o.Status == "cancelled") || (outcomes.Count == 0 && running.UserCancelled)) return "cancelled";
            if (outcomes.Any(o => o.Status == "timedOut")) return "timedOut";
            return "failed";
        }

        var succeededCount = outcomes.Count(o => o.Status == "succeeded");
        if (outcomes.Count > 0 && succeededCount == outcomes.Count)
        {
            return outcomes.Any(o => o.Error is not null) ? "completedWithErrors" : "completed";
        }
        if (succeededCount > 0) return "partialFailure";
        if (outcomes.Any(o => o.Status == "cancelled") || (outcomes.Count == 0 && running.UserCancelled)) return "cancelled";
        if (outcomes.Any(o => o.Status == "timedOut")) return "timedOut";
        return "failed";
    }

    private QueryMultiResult FinalizeResult(
        string mode,
        string status,
        List<MultiTargetOutcome> targetOutcomes,
        List<ResultSetBuffer> allSets,
        IMultiQueryQuota quota,
        QueryBudget budget,
        QueryMessages messages,
        Stopwatch watch,
        List<string>? combineWarnings)
    {
        allSets.Sort((a, b) => a.Index.CompareTo(b.Index));
        var descriptors = allSets.Select(set => set.Describe()).ToList();
        var output = messages.Snapshot();

        var reasons = descriptors.Select(d => d.Truncated).ToHashSet();
        if (budget.Stopped is not TruncationReason.None and var stopped) reasons.Add(ResultSetBuffer.Name(stopped));
        if (reasons.Contains("rowLimit") || descriptors.Any(d => d.TruncatedCells > 0))
            output.Add(new MessageEntry("Results were truncated by display limits. Display limits do not stop script execution.", QueryMessages.Info));
        if (reasons.Contains("queryBudget") || reasons.Contains("globalBudget"))
            output.Add(new MessageEntry(SqlService.BudgetFullNote(budget.StoppedBytes ?? (reasons.Contains("queryBudget") ? service.Results.QueryLimit(budget) : service.Results.GlobalBytes)), QueryMessages.Info));
        if (reasons.Contains("systemMemory"))
            output.Add(new MessageEntry("Results were truncated because the computer is low on memory. Execution continued.", QueryMessages.Info));

        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        var summaryBudget = service.SummaryBudget(budget.StoppedBytes);

        var clampedOutcomes = targetOutcomes.Select(o => o.Error is null ? o : o with { Error = ClampError(o.Error) }).ToList();
        List<string>? clampedWarnings = null;
        if (combineWarnings is { Count: > 0 })
        {
            clampedWarnings = new List<string>(Math.Min(combineWarnings.Count, 64));
            foreach (var warning in combineWarnings)
            {
                if (clampedWarnings.Count >= 64) break;
                if (string.IsNullOrWhiteSpace(warning)) continue;
                clampedWarnings.Add(ClampText(warning, 512));
            }
            if (clampedWarnings.Count == 0) clampedWarnings = null;
        }

        return new QueryMultiResult(
            status,
            mode,
            clampedOutcomes,
            descriptors,
            quota.DiscardedResultSets,
            output,
            messages.Truncated,
            watch.ElapsedMilliseconds,
            summaryBudget,
            completedAt,
            clampedWarnings);
    }

    internal static string ClampText(string text, int maxChars)
    {
        if (text.Length <= maxChars) return text;
        if (maxChars <= 0) return "";
        if (maxChars == 1) return char.IsHighSurrogate(text[0]) ? "" : text[..1];
        var take = maxChars - 1;
        if (take > 0 && char.IsHighSurrogate(text[take - 1])) take--;
        return text[..take] + "…";
    }

    internal static MultiTargetError ClampError(MultiTargetError error) =>
        error with
        {
            Code = ClampText(string.IsNullOrEmpty(error.Code) ? "BACKEND_ERROR" : error.Code, 64),
            Message = ClampText(error.Message ?? "", 16385)
        };

    private static string? ClampEventMessage(string? message) =>
        message is null ? null : ClampText(message, 2000);

    private static MultiTargetOutcome EmptyOutcome(MultiTargetContext ctx, string status, long elapsedMs, MultiTargetError? error) =>
        new(
            ctx.Target.TargetKey,
            ctx.Provider,
            ctx.Target.Label,
            status,
            0,
            0,
            0,
            elapsedMs,
            [],
            ctx.Target.Environment,
            Spid: null,
            Login: null,
            BytesProcessed: null,
            Job: null,
            Error: error);

    private static void TryCancel(CancellationTokenSource source)
    {
        try { source.Cancel(); }
        catch (ObjectDisposedException) { }
    }

    private static async Task DisposeQuietlyAsync(IMultiTargetPhase2Handle handle)
    {
        try { await handle.DisposeAsync().ConfigureAwait(false); }
        catch (Exception) { }
    }
}

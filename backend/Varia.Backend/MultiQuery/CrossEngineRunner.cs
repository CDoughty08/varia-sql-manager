using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;

namespace Varia.Backend.MultiQuery;

/// <summary>Outcome of Cross-Engine (<c>crossEngineReadOnly</c>) pre-flight validation across both dialects.</summary>
internal sealed record CrossEnginePreflightResult(
    bool Passed,
    string? ErrorCode = null,
    string? Message = null,
    string? Dialect = null,
    string? TargetKey = null,
    int? Line = null,
    IReadOnlyList<ReadOnlySqlViolation>? SqlServerViolations = null,
    IReadOnlyList<MultiTargetPreflightOutcome>? BigQueryOutcomes = null);

/// <summary>
/// Cross-Engine (<c>crossEngineReadOnly</c>) pre-flight validator (docs/multi-server-query.md).
/// Combines <see cref="IReadOnlySqlValidator"/> (T-SQL AST allowlist with <c>startLines?.Sqlserver ?? 1</c>) with
/// BigQuery's <see cref="GoogleSqlScanner.IsReadOnlySelect"/> allowlist and free <c>dryRun: true</c> through
/// <see cref="BigQueryService.MetadataAsync"/> asserting <c>estimate.Faked || estimate.StatementType == "SELECT"</c>,
/// rewriting BigQuery error positions via <see cref="SqlService.EditorPositions"/> with <c>startLines?.Bigquery ?? 1, 1</c>.
/// Any violation stops pre-flight with <c>READ_ONLY_VIOLATION</c> and zero queries executed.
/// </summary>
internal sealed class CrossEngineRunner(SqlService service, IReadOnlySqlValidator sqlValidator)
{
    private readonly BigQueryService bigQuery = service.BigQuery;

    public Task<CrossEnginePreflightResult> ValidatePreflightAsync(
        QueryMultiArgs args,
        IReadOnlyList<MultiTargetContext> bigQueryTargets,
        CancellationToken token) =>
        ValidatePreflightAsync(
            args.Scripts?.Sqlserver ?? "",
            args.StartLines?.Sqlserver ?? 1,
            args.Scripts?.Bigquery ?? "",
            args.StartLines?.Bigquery ?? 1,
            bigQueryTargets,
            token);

    public async Task<CrossEnginePreflightResult> ValidatePreflightAsync(
        string sqlServerSql,
        int sqlServerStartLine,
        string bigQuerySql,
        int bigQueryStartLine,
        IReadOnlyList<MultiTargetContext> bigQueryTargets,
        CancellationToken token)
    {
        var normalizedSqlStart = Math.Max(1, sqlServerStartLine);
        var normalizedBqStart = Math.Max(1, bigQueryStartLine);

        // 1. Validate T-SQL read-only AST allowlist before any network call.
        var sqlViolations = await sqlValidator.ValidateTSqlAsync(sqlServerSql, normalizedSqlStart, token);
        if (sqlViolations.Count > 0)
        {
            var first = sqlViolations[0];
            return new(
                Passed: false,
                ErrorCode: "READ_ONLY_VIOLATION",
                Message: first.Message,
                Dialect: Providers.SqlServer,
                Line: first.Line,
                SqlServerViolations: sqlViolations);
        }

        // 2. Validate GoogleSQL single-statement SELECT/WITH allowlist and reject legacy SQL before any dry-run.
        if (ValidateBigQueryStatic(bigQuerySql, normalizedBqStart) is { } staticErr)
        {
            return new(
                Passed: false,
                ErrorCode: staticErr.Code,
                Message: staticErr.Message,
                Dialect: Providers.BigQuery,
                Line: staticErr.Line);
        }

        if (bigQueryTargets.Count == 0)
            return new(Passed: true, BigQueryOutcomes: []);

        // 3. Free dryRun: true through MetadataAsync across all BigQuery targets asserting Faked || StatementType == "SELECT".
        var outcomes = new MultiTargetPreflightOutcome[bigQueryTargets.Count];
        using var gate = new SemaphoreSlim(Math.Min(bigQueryTargets.Count, 8));
        var tasks = new Task[bigQueryTargets.Count];
        for (var i = 0; i < bigQueryTargets.Count; i++)
        {
            var idx = i;
            var target = bigQueryTargets[idx];
            tasks[idx] = Task.Run(async () =>
            {
                await gate.WaitAsync(token);
                try
                {
                    outcomes[idx] = (await DryRunBigQueryTargetWithLocationAsync(target, bigQuerySql, normalizedBqStart, token)).Outcome;
                }
                finally
                {
                    gate.Release();
                }
            }, token);
        }
        await Task.WhenAll(tasks);

        foreach (var outcome in outcomes)
        {
            if (!outcome.Passed)
            {
                return new(
                    Passed: false,
                    ErrorCode: outcome.Error?.Code ?? "READ_ONLY_VIOLATION",
                    Message: outcome.Error?.Message ?? "BigQuery cross-engine pre-flight failed.",
                    Dialect: Providers.BigQuery,
                    TargetKey: outcome.TargetKey,
                    Line: outcome.Error?.Line,
                    BigQueryOutcomes: outcomes);
            }
        }

        return new(Passed: true, BigQueryOutcomes: outcomes);
    }

    internal static MultiTargetError? ValidateBigQueryStatic(string bigQuerySql, int bigQueryStartLine)
    {
        var normalizedBqStart = Math.Max(1, bigQueryStartLine);
        if (BigQueryErrors.IsLegacySql(bigQuerySql))
            return new MultiTargetError("LEGACY_SQL", BigQueryErrors.LegacySql, Line: normalizedBqStart);

        var bqStatic = GoogleSqlScanner.InspectReadOnlySelect(bigQuerySql);
        if (!bqStatic.Allowed)
            return new MultiTargetError("READ_ONLY_VIOLATION", bqStatic.Message, Line: OffsetLine(normalizedBqStart, bqStatic.Line));

        return null;
    }

    internal async Task<(MultiTargetPreflightOutcome Outcome, string? ResolvedLocation)> DryRunBigQueryTargetWithLocationAsync(
        MultiTargetContext target,
        string bigQuerySql,
        int bigQueryStartLine,
        CancellationToken token)
    {
        var normalizedStart = Math.Max(1, bigQueryStartLine);
        var connection = bigQuery.Find(target.Target.ConnectionId);
        using var lease = connection?.Lease();
        if (connection is null || lease is null)
            return (new(target.Target.TargetKey, false, new MultiTargetError("NOT_CONNECTED", "The BigQuery connection is no longer open.")), null);

        var dataset = target.Target.Dataset ?? connection.Options.Dataset;
        var location = await service.ResolveBigQueryLocationAsync(connection, dataset, token);

        BigQueryEstimate estimate;
        try
        {
            estimate = await bigQuery.EstimateAsync(connection, bigQuerySql, token, dataset: dataset, location: location);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (RequestException error)
        {
            var rewritten = SqlService.EditorPositions(error.Message, normalizedStart, 1, out var line);
            return (new(target.Target.TargetKey, false, new MultiTargetError(error.Code, rewritten, Line: line)), null);
        }
        catch (Exception error)
        {
            var mapped = BigQueryErrors.Map(error, connection.Options.Project, token: token) as RequestException
                ?? new RequestException("BACKEND_ERROR", "Dry run failed: " + BigQueryErrors.Sanitize(error.Message));
            var rewritten = SqlService.EditorPositions(mapped.Message, normalizedStart, 1, out var line);
            return (new(target.Target.TargetKey, false, new MultiTargetError(mapped.Code, rewritten, Line: line)), null);
        }

        if (!estimate.Faked && !string.Equals(estimate.StatementType, "SELECT", StringComparison.Ordinal))
        {
            return (new(target.Target.TargetKey, false, new MultiTargetError(
                "READ_ONLY_VIOLATION",
                $"Cross-Engine BigQuery requires a single SELECT statement (BigQuery reported {estimate.StatementType ?? "unknown"}).",
                Line: normalizedStart)), null);
        }

        return (new(target.Target.TargetKey, true, EstimatedBytes: estimate.BytesProcessed), location ?? estimate.Location);
    }

    private static int OffsetLine(int startLine, int relativeLine)
    {
        var line = (long)Math.Max(1, startLine) + Math.Max(1, relativeLine) - 1;
        return line > int.MaxValue ? int.MaxValue : (int)line;
    }
}

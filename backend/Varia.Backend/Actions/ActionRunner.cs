using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>What a runner step gets: the transaction it runs in (transaction mode only) and its token, the job's for a main
/// step and a fresh one bounded by the action's cleanup budget for a compensation or cleanup.</summary>
internal sealed record StepContext(SqlTransaction? Transaction, CancellationToken Token);

/// <summary>One step of runner v2 (critic A4). Undoes: for a compensation, the index among the main steps of the step whose change
/// it undoes. When: whether a compensation or cleanup is due, from the main steps' statuses. Detail: a name it acts on, never a secret.
/// Confirm: for a compensation whose main step was cancelled, whether that step's change happened all the same (Stop can reach a
/// statement SQL Server has finished before its answer is read), asked on the server under the cleanup budget; without it, a
/// compensation runs only after its main step completed.</summary>
internal sealed record RunStep(string Title, Func<StepContext, Task> Run, StepKind Kind = StepKind.Main, int? Undoes = null, Func<IReadOnlyList<string>, bool>? When = null,
    string? Detail = null, Func<StepContext, Task<bool>>? Confirm = null);

/// <summary>A runner's answer: the steps as the reply lists them, the failure (null when every main step completed), and how many
/// main steps completed (none once a transaction rolled back).</summary>
internal sealed record RunOutcome(List<ActionStepDto> Steps, ActionError? Failure, int Done);

/// <summary>Bounds every step the replies carry (zod's actionStepSchema checks the same in main).</summary>
internal static class ActionSteps
{
    public const int MaxTitle = 64, MaxDetail = 128;

    public static ActionStepDto Bound(ActionStepDto step) => step with
    {
        Title = ScriptingErrors.Clip(step.Title, MaxTitle),
        Message = step.Message is null ? null : ScriptingErrors.Clip(step.Message, ActionErrors.MaxMessage),
        Detail = step.Detail is null ? null : ScriptingErrors.Clip(step.Detail, MaxDetail),
        Progress = step.Progress is { } progress ? Math.Clamp(progress, 0, 100) : null
    };
}

internal sealed partial class ActionService
{
    /// <summary>Runner v2. Main steps run in order on the action's connection: the first failure stops the rest, which are
    /// 'skipped'; Stop cancels the running statement, and earlier steps stay 'done'. In transaction mode the main steps run in one
    /// transaction followed by <paramref name="commitTitle"/>'s commit (which Stop no longer reaches), and a failure or Stop
    /// rolls it back (within StopGrace, else closing the unpooled connection ends the session, which rolls it back);
    /// <paramref name="rolledBack"/> then joins the failure's message. <paramref name="serverText"/> rewrites the text of SQL Server's errors
    /// (New Login removes its password from it), never the runner's or ActionErrors' own sentences. After a failure or Stop, the compensation and cleanup
    /// steps that are due run in order under a fresh token bounded by <paramref name="cleanupBudget"/>, so a Stop's reply (which
    /// waits StopGrace plus that budget) still lists them. They are listed only when they run, marked compensates. With
    /// <paramref name="progress"/>, each step's 3211 messages count for its index in the reply, and the step carries its last percent.</summary>
    internal async Task<RunOutcome> RunStepsAsync(SqlConnection connection, IReadOnlyList<RunStep> plan, string? inUseAdvice, CancellationToken token, TimeSpan cleanupBudget,
        bool transaction = false, string commitTitle = "Commit", string? rolledBack = null, ActionProgress? progress = null, Func<string, string>? serverText = null)
    {
        var mains = plan.Where(step => step.Kind == StepKind.Main).ToList();
        var after = plan.Where(step => step.Kind != StepKind.Main).ToList();
        if (transaction && after.Count > 0) throw new InvalidOperationException("A transaction rolls back; it has no compensation or cleanup steps.");
        if (after.Any(step => step.Kind == StepKind.Compensation && (step.Undoes is not { } undone || undone < 0 || undone >= mains.Count)))
            throw new InvalidOperationException("A compensation must name the main step it undoes.");
        var steps = new List<ActionStepDto>();
        var statuses = new List<string>();
        ActionError? failure = null;
        var completed = 0;
        var committed = false;
        SqlTransaction? open = null;
        if (transaction)
        {
            open = (SqlTransaction)await connection.BeginTransactionAsync(token);
            // Stop has no say once the commit is sent: its outcome is the server's.
            mains.Add(new(commitTitle, async _ => { await open.CommitAsync(CancellationToken.None); committed = true; }));
        }
        void Add(string status, RunStep step, string? message = null)
        {
            steps.Add(ActionSteps.Bound(new(status, step.Title, message, step.Detail, step.Kind == StepKind.Main ? null : true, progress?.PercentOf(steps.Count))));
            if (step.Kind == StepKind.Main) statuses.Add(status);
        }
        List<string> Done() => [.. mains.Take(statuses.Count).Where((_, index) => statuses[index] == "done").Select(step => step.Title)];
        try
        {
            foreach (var step in mains)
            {
                if (failure is not null) { Add("skipped", step); continue; }
                try
                {
                    if (Options.BeforeStep is { } before) await before(step.Title, token);
                    token.ThrowIfCancellationRequested();
                    progress?.Begin(steps.Count);
                    await step.Run(new(open, token));
                    Add("done", step);
                    completed++;
                    Options.AfterStep?.Invoke(step.Title);
                }
                catch (Exception exception) when (token.IsCancellationRequested && exception is SqlException or OperationCanceledException)
                {
                    Add("cancelled", step);
                    var done = Done();
                    failure = Error("CANCELLED", "The action was stopped at \"" + step.Title + "\"; SQL Server cancelled that statement."
                        + (done.Count == 0 ? "" : " Completed before Stop: " + string.Join(", ", done) + "."));
                }
                catch (SqlException sql)
                {
                    var value = ActionErrors.FromSql(catalog, sql, connection, ddl: true, inUseAdvice, serverText);
                    Add("failed", step, value.Message);
                    var done = Done();
                    failure = done.Count == 0 ? value : value with { Message = ScriptingErrors.Clip(value.Message + " Completed before the failure: " + string.Join(", ", done) + ".", ActionErrors.MaxMessage) };
                }
            }
        }
        finally
        {
            if (open is not null)
            {
                if (!committed)
                {
                    try { await open.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
                    // XACT_ABORT or the attention may have rolled it back already; otherwise closing the session does.
                    catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
                    completed = 0;
                    if (failure is not null && failure.Code != "CONNECTION_LOST" && rolledBack is not null)
                        failure = failure with { Message = ScriptingErrors.Clip(failure.Message + " " + rolledBack, ActionErrors.MaxMessage) };
                }
                await open.DisposeAsync();
            }
        }
        if (failure is null || after.Count == 0) return new(steps, failure, completed);
        var outcomes = new List<string>();
        using var budget = new CancellationTokenSource(cleanupBudget);
        foreach (var step in after)
        {
            var undone = step.Kind == StepKind.Compensation ? statuses[step.Undoes!.Value] : null;
            var confirm = undone == "cancelled" && step.Confirm is not null;
            var due = (step.Kind != StepKind.Compensation || undone == "done" || confirm) && (step.When?.Invoke(statuses) ?? true);
            if (!due) continue;
            try
            {
                budget.Token.ThrowIfCancellationRequested();
                if (connection.State != ConnectionState.Open) throw new InvalidOperationException("The connection is closed.");
                if (confirm && !await step.Confirm!(new(null, budget.Token))) continue;
                if (Options.BeforeCleanup is { } before) await before(step.Title, budget.Token);
                progress?.Begin(steps.Count);
                await step.Run(new(null, budget.Token));
                Add("done", step);
                outcomes.Add("\"" + step.Title + "\" completed");
            }
            catch (Exception exception) when (budget.IsCancellationRequested && exception is SqlException or OperationCanceledException)
            {
                Add("cancelled", step);
                outcomes.Add("\"" + step.Title + "\" did not finish within " + (int)cleanupBudget.TotalSeconds + " seconds");
            }
            catch (SqlException sql)
            {
                Add("failed", step, ActionErrors.FromSql(catalog, sql, connection, ddl: true, null, serverText).Message);
                outcomes.Add("\"" + step.Title + "\" failed");
            }
            // The failure or Stop broke the connection (a severe error closes it): the step could not run.
            catch (InvalidOperationException)
            {
                Add("failed", step, "The connection was lost, so this step could not run.");
                outcomes.Add("\"" + step.Title + "\" could not run");
            }
        }
        if (outcomes.Count > 0) failure = failure with { Message = ScriptingErrors.Clip(failure.Message + " Then " + string.Join(", ", outcomes) + ".", ActionErrors.MaxMessage) };
        return new(steps, failure, completed);
    }
}

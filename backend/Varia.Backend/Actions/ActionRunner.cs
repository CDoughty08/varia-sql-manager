using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>What a runner step gets: the transaction it runs in (transaction mode only) and its token, the job's for a main
/// step and a fresh one bounded by the action's cleanup budget for a compensation or cleanup.</summary>
internal sealed record StepContext(SqlTransaction? Transaction, CancellationToken Token);

/// <summary>One step of runner v2 (critic A4). Undoes: for a compensation, the index among the main steps of the step whose change
/// it undoes. When: whether a compensation or cleanup is due, from the main steps' statuses. Detail: a name it acts on, never a secret.</summary>
internal sealed record RunStep(string Title, Func<StepContext, Task> Run, StepKind Kind = StepKind.Main, int? Undoes = null, Func<IReadOnlyList<string>, bool>? When = null,
    string? Detail = null);

/// <summary>A runner's answer: the steps as the reply lists them, the failure (null when every main step completed), and how many
/// main steps completed (none once a transaction rolled back).</summary>
internal sealed record RunOutcome(List<ActionStepDto> Steps, ActionError? Failure, int Done);

/// <summary>Thrown by a step that checks the server again before it changes anything and finds that it must not run (Unlock's
/// recheck in its transaction): the runner fails the step with <see cref="Error"/> as the action's answer.</summary>
internal sealed class StepRefusedException(ActionError error) : Exception(error.Message)
{
    public ActionError Error { get; } = error;
}

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
    /// rolls it back (within StopGrace, else closing the unpooled connection ends the session, which rolls it back): the steps
    /// that completed are then 'rolledBack', the message names none as completed, and <paramref name="rolledBack"/> joins it
    /// (unless a step refused before anything ran). After a failure or Stop, the compensation and cleanup
    /// steps that are due run in order under a fresh token bounded by <paramref name="cleanupBudget"/>, so a Stop's reply (which
    /// waits StopGrace plus that budget) still lists them. They are listed only when they run, marked compensates.</summary>
    internal async Task<RunOutcome> RunStepsAsync(SqlConnection connection, IReadOnlyList<RunStep> plan, string? inUseAdvice, CancellationToken token, TimeSpan cleanupBudget,
        bool transaction = false, string commitTitle = "Commit", string? rolledBack = null)
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
        var commitSent = false;
        var refused = false;
        SqlTransaction? open = null;
        if (transaction)
        {
            open = (SqlTransaction)await connection.BeginTransactionAsync(token);
            // Stop has no say once the commit is sent: its outcome is the server's.
            mains.Add(new(commitTitle, async _ => { commitSent = true; await open.CommitAsync(CancellationToken.None); committed = true; }));
        }
        void Add(string status, RunStep step, string? message = null)
        {
            steps.Add(ActionSteps.Bound(new(status, step.Title, message, step.Detail, step.Kind == StepKind.Main ? null : true)));
            if (step.Kind == StepKind.Main) statuses.Add(status);
        }
        // A transaction's completed steps are rolled back with it, so its messages name none as completed.
        List<string> Done() => transaction ? [] : [.. mains.Take(statuses.Count).Where((_, index) => statuses[index] == "done").Select(step => step.Title)];
        try
        {
            foreach (var step in mains)
            {
                if (failure is not null) { Add("skipped", step); continue; }
                try
                {
                    if (Options.BeforeStep is { } before) await before(step.Title, token);
                    token.ThrowIfCancellationRequested();
                    await step.Run(new(open, token));
                    Add("done", step);
                    completed++;
                }
                catch (Exception exception) when (token.IsCancellationRequested && exception is SqlException or OperationCanceledException)
                {
                    Add("cancelled", step);
                    var done = Done();
                    failure = Error("CANCELLED", "The action was stopped at \"" + step.Title + "\"; SQL Server cancelled that statement."
                        + (done.Count == 0 ? "" : " Completed before Stop: " + string.Join(", ", done) + "."));
                }
                catch (StepRefusedException refusal)
                {
                    Add("failed", step, refusal.Error.Message);
                    var done = Done();
                    refused = true;
                    failure = done.Count == 0 ? refusal.Error : refusal.Error with { Message = ScriptingErrors.Clip(refusal.Error.Message + " Completed before the failure: " + string.Join(", ", done) + ".", ActionErrors.MaxMessage) };
                }
                catch (SqlException sql)
                {
                    var value = ActionErrors.FromSql(catalog, sql, connection, ddl: true, inUseAdvice);
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
                    // Before the commit was sent, SQL Server has rolled back every step that completed (a commit that failed or lost
                    // its connection has an outcome only the server knows, so those steps stay as they ran).
                    var undone = !commitSent && completed > 0;
                    if (!commitSent)
                        for (var index = 0; index < statuses.Count; index++)
                            if (statuses[index] == "done") { statuses[index] = "rolledBack"; steps[index] = steps[index] with { Status = "rolledBack" }; }
                    completed = 0;
                    if (failure is not null && failure.Code != "CONNECTION_LOST" && rolledBack is not null && (undone || !refused))
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
            var due = (step.Kind != StepKind.Compensation || statuses[step.Undoes!.Value] == "done") && (step.When?.Invoke(statuses) ?? true);
            if (!due) continue;
            try
            {
                budget.Token.ThrowIfCancellationRequested();
                if (connection.State != ConnectionState.Open) throw new InvalidOperationException("The connection is closed.");
                if (Options.BeforeCleanup is { } before) await before(step.Title, budget.Token);
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
                Add("failed", step, ActionErrors.FromSql(catalog, sql, connection, ddl: true, null).Message);
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

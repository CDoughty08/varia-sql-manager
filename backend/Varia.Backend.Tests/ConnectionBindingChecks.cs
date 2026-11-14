using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

internal static class ConnectionBindingChecks
{
    private const string Before = "before-password-marker", After = "after-password-marker";
    private static ServerProfile Profile(string server = "S1", string login = "reader", bool contained = false) =>
        new(16, "16.0.1000", 3, login, false, true, false, ServerName: server, Contained: contained, PrincipalId: "sid:01");
    private static string Settings(string? database = "Sales", string login = "reader", bool windows = false) =>
        new SqlConnectionStringBuilder { DataSource = "offline", InitialCatalog = database ?? "", IntegratedSecurity = windows,
            UserID = windows ? "" : login, Password = windows ? "" : Before }.ConnectionString;
    private static SqlConnectionStringBuilder Current(SqlService sql, string id)
    {
        using var connection = ((IExplorerHost)sql).Connection(id, null);
        return new(connection.ConnectionString);
    }

    public static async Task RunAsync(Action<bool, string> check)
    {
        using var sql = new SqlService();
        var acting = sql.Register(Settings("master", "admin"), Profile(login: "admin"), "master");
        var named = sql.Register(Settings(), Profile(), "Sales");
        var defaulted = sql.Register(Settings(null), Profile(), "Sales");
        var otherServer = sql.Register(Settings(), Profile("S2"), "Sales");
        var otherLogin = sql.Register(Settings(login: "other"), Profile(login: "other"), "Sales");
        var windows = sql.Register(Settings(windows: true), Profile(), "Sales");
        var contained = sql.Register(Settings(), Profile(contained: true), "Sales");
        var partial = await sql.CaptureBindingChangesAsync(async () =>
        {
            // ActionService executes its work in a child task; the receipt belongs to this request, not process-wide state.
            await Task.Run(() => sql.PasswordChanged(acting, "reader", After));
            sql.DatabaseChanged(acting, "Sales", "Sales2");
            return new([], [], 0, new("PERMISSION_DENIED", "A later action step failed.", false));
        });
        var changes = partial.BindingChanges!;
        check(partial.Error?.Code == "PERMISSION_DENIED" && partial.BindingChangesComplete == true && changes.Count == 5,
            "a partial-success action result acknowledges all confirmed local binding changes, including child-task work");
        check(new[] { named, defaulted }.All(id => changes.Single(change => change.ConnectionId == id) is { BindingRevision: 2, NewDatabase: "Sales2", PasswordChanged: true })
            && new[] { otherLogin, windows, contained }.All(id => changes.Single(change => change.ConnectionId == id) is { BindingRevision: 1, NewDatabase: "Sales2", PasswordChanged: null }),
            "same-request mutations coalesce by handle with the latest revision, last database and password-change flag");
        check(changes.All(change => change.ConnectionId != acting && change.ConnectionId != otherServer)
            && Current(sql, named) is { InitialCatalog: "Sales2", Password: After } && Current(sql, defaulted) is { InitialCatalog: "Sales2", Password: After }
            && Current(sql, otherServer) is { InitialCatalog: "Sales", Password: Before } && Current(sql, otherLogin).Password == Before
            && Current(sql, windows).IntegratedSecurity && Current(sql, contained).Password == Before,
            "database changes preserve same-server scope while password changes update only the actual matching SQL login, never another server, Windows or contained users");
        var serialized = JsonSerializer.Serialize(partial, HostChecks.Json);
        check(!serialized.Contains(Before, StringComparison.Ordinal) && !serialized.Contains(After, StringComparison.Ordinal)
            && !serialized.Contains("Data Source", StringComparison.OrdinalIgnoreCase), "binding receipts contain no password or connection string");

        var next = await sql.CaptureBindingChangesAsync(() =>
        {
            sql.PasswordChanged(acting, "reader", Before);
            return Task.FromResult(new ActionExecuteResult([], [], 0));
        });
        check(next.BindingChangesComplete == true && next.BindingChanges is { Count: 2 } && next.BindingChanges.All(change => change is { BindingRevision: 3, NewDatabase: null, PasswordChanged: true }),
            "binding revisions increase across actions and request-local receipts do not retain an earlier database delta");
        var noChanges = await sql.CaptureBindingChangesAsync(() => Task.FromResult(new ActionExecuteResult([], [], 0)));
        check(noChanges.BindingChanges is { Count: 0 } && noChanges.BindingChangesComplete == true,
            "every settled action can explicitly acknowledge that it made no local binding changes");

        foreach (var code in new[] { "CONNECTION_LOST", "CANCELLED" })
        {
            var unknown = await sql.CaptureBindingChangesAsync(() => Task.FromResult(new ActionExecuteResult([], [], 0, new(code, "The last statement's outcome is unknown.", false))));
            check(unknown.BindingChanges is { Count: 0 } && unknown.BindingChangesComplete == false,
                "a returned " + code + " cannot acknowledge an unchanged binding when the server may have applied the last statement");
            var confirmed = await sql.CaptureBindingChangesAsync(() =>
            {
                sql.PasswordChanged(acting, "reader", After);
                return Task.FromResult(new ActionExecuteResult([], [], 0, new(code, "A later statement's outcome is unknown.", false)));
            });
            check(confirmed.BindingChanges is { Count: 2 } && confirmed.BindingChanges.All(change => change.PasswordChanged == true) && confirmed.BindingChangesComplete == false,
                "a returned " + code + " preserves confirmed earlier binding receipts without claiming the capture is complete");
        }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var passwordAction = sql.CaptureBindingChangesAsync(async () =>
        {
            entered.SetResult(); await release.Task;
            sql.PasswordChanged(acting, "reader", After);
            return new([], [], 0);
        });
        await entered.Task;
        var databaseAction = await sql.CaptureBindingChangesAsync(() =>
        {
            sql.DatabaseChanged(acting, "Sales2", "Sales3");
            return Task.FromResult(new ActionExecuteResult([], [], 0));
        });
        release.SetResult();
        var passwordResult = await passwordAction;
        check(databaseAction.BindingChanges!.All(change => change.NewDatabase == "Sales3" && change.PasswordChanged is null)
            && passwordResult.BindingChanges!.All(change => change.NewDatabase is null && change.PasswordChanged == true)
            && new[] { named, defaulted }.All(id => passwordResult.BindingChanges!.Single(change => change.ConnectionId == id).BindingRevision
                > databaseAction.BindingChanges!.Single(change => change.ConnectionId == id).BindingRevision)
            && Current(sql, named) is { InitialCatalog: "Sales3", Password: After },
            "overlapping request captures stay isolated and serial settings mutations preserve both password and database with monotonic per-handle revisions");

        var failed = false;
        try
        {
            await sql.CaptureBindingChangesAsync(() =>
            {
                sql.PasswordChanged(acting, "reader", Before);
                throw new RequestException("CONNECTION_LOST", "The action outcome is unknown.");
            });
        }
        catch (RequestException error) { failed = error.Code == "CONNECTION_LOST"; }
        noChanges = await sql.CaptureBindingChangesAsync(() => Task.FromResult(new ActionExecuteResult([], [], 0)));
        check(failed && noChanges.BindingChanges is { Count: 0 }, "an unknown action outcome is not converted into an acknowledgement or leaked into a later request");

        var managed = sql.Register(Settings("master", "admin"), Profile(login: "admin") with { EngineEdition = 8 }, "master");
        var reply = (ActionExecuteResult)await sql.DispatchAsync("actions.execute", JsonSerializer.SerializeToElement(
            new ActionArgs("delete", managed, Guid.NewGuid().ToString(), new("database", Name: "Sales"), CloseConnections: true, DeleteHistory: false), HostChecks.Json), HostChecks.Json);
        check(reply.Error?.Code == "NOT_SUPPORTED" && reply.BindingChanges is { Count: 0 } && reply.BindingChangesComplete == true,
            "the real actions.execute result wrapper emits bounded binding receipts even for a preflight refusal");

        using var many = new SqlService();
        var ids = Enumerable.Range(0, SqlService.MaxBindingChanges + 1).Select(_ => many.Register(Settings("master"), Profile(), "master")).ToArray();
        var bounded = await many.CaptureBindingChangesAsync(() =>
        {
            many.PasswordChanged(ids[0], "reader", After);
            return Task.FromResult(new ActionExecuteResult([], [], 0));
        });
        check(bounded.BindingChanges is { Count: SqlService.MaxBindingChanges } && bounded.BindingChangesComplete == false
            && ids.All(id => Current(many, id).Password == After),
            "receipt overflow is explicit and bounded without disabling a valid login operation or pretending all changed handles were acknowledged");
    }
}

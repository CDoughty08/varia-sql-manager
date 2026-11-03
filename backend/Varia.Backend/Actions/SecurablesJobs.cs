using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The Securables page of New Login and Login Properties (D2d): its lists in New Login's describe, the login's explicit
/// permissions in Login Properties', the Effective tab's read, and the permission steps both runs end with (PermissionSql). Names,
/// permissions and SQL are never logged.</summary>
internal sealed partial class ActionService
{
    /// <summary>Joined to a New Login failure after CREATE LOGIN when a permission step did not complete.</summary>
    internal const string LoginPermissionsMessage = "Not every permission was set.";

    /// <summary>The Securables page's lists, in master on the describe's connection (PermissionSql.Describe): the server's name, the
    /// catalogue's permissions this server lists per type (in the catalogue's order), and each named type's objects (one more is read,
    /// so a truncation shows).</summary>
    private async Task<SecurablesModelDto> SecurablesAsync(SqlConnection connection, CancellationToken token)
    {
        var securables = catalog.Logins.Securables;
        var take = (int)catalog.Logins.Limit("securableObjects");
        await using var command = connection.CreateCommand();
        command.CommandText = PermissionSql.Describe;
        command.CommandTimeout = 0;
        Add(command, "@take", SqlDbType.Int, 0, take + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        var server = "";
        if (await reader.ReadAsync(token) && !reader.IsDBNull(0)) server = reader.GetString(0);
        var builtin = new HashSet<(string, string)>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) if (!reader.IsDBNull(0) && !reader.IsDBNull(1)) builtin.Add((reader.GetString(0), reader.GetString(1)));
        var permissions = securables.Types.ToDictionary(type => type.Type, type => type.Permissions.Where(permission => builtin.Contains((type.SqlClass, permission))).ToList(), StringComparer.Ordinal);
        var objects = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var truncated = false;
        foreach (var type in PermissionSql.DescribeOrder)
        {
            var names = new List<string>();
            if (await reader.NextResultAsync(token)) while (await reader.ReadAsync(token)) names.Add(reader.GetString(0));
            truncated |= names.Count > take;
            objects[type] = [.. names.Take(take)];
        }
        return new(server, permissions, objects, truncated);
    }

    /// <summary>The login's explicit permissions (PermissionSql.Explicit), by its principal_id: rows whose securable resolves to a type of
    /// the catalogue, with state grant, withGrant or deny; Truncated when more rows exist than loginLimits.explicitPermissions.</summary>
    private async Task<(List<ExplicitPermissionDto> Rows, bool Truncated)> ExplicitPermissionsAsync(SqlConnection connection, int principalId, CancellationToken token)
    {
        var take = (int)catalog.Logins.Limit("explicitPermissions");
        await using var command = connection.CreateCommand();
        command.CommandText = PermissionSql.Explicit;
        command.CommandTimeout = 0;
        Add(command, "@principal", SqlDbType.Int, 0, principalId);
        Add(command, "@take", SqlDbType.Int, 0, take + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        var rows = new List<ExplicitPermissionDto>();
        var count = 0;
        while (await reader.ReadAsync(token))
        {
            if (++count > take) break;
            var classId = Convert.ToInt32(reader.GetValue(0), System.Globalization.CultureInfo.InvariantCulture);
            var principalType = reader.IsDBNull(1) ? null : reader.GetString(1).Trim();
            var name = reader.IsDBNull(2) ? null : reader.GetString(2);
            var type = classId switch
            {
                100 => "server",
                105 => "endpoint",
                101 => principalType == "R" ? "serverRole" : "login",
                108 => "availabilityGroup",
                _ => null
            };
            if (type is null || (type != "server" && name is null)) continue;
            var state = reader.GetString(4).Trim() switch { "G" => "grant", "W" => "withGrant", "D" => "deny", _ => null };
            if (state is null) continue;
            rows.Add(new(new(type, type == "server" ? null : name), reader.GetString(3), state, reader.IsDBNull(5) ? "" : reader.GetString(5)));
        }
        return (rows, count > take);
    }

    /// <summary>The Effective tab's read (the loginEffectivePermissions describe): what the login may do on the securable, through
    /// sys.fn_my_permissions as the login (PermissionSql.Effective). SQL Server refuses EXECUTE AS LOGIN without IMPERSONATE (15406, 15517);
    /// that is a value with the catalogue's words. A login that no longer exists is NOT_FOUND.</summary>
    private async Task<ActionDescribeResult> DescribeEffectiveJobAsync(SqlConnection connection, ObjectRefDto target, SecurableRefDto securable, CancellationToken token)
    {
        var take = (int)catalog.Logins.Limit("effectivePermissions");
        var spec = catalog.Logins.Securables.Type(securable.Type)!;
        await using var command = connection.CreateCommand();
        command.CommandText = PermissionSql.Effective;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
        Add(command, "@securable", SqlDbType.NVarChar, 128, securable.Name);
        Add(command, "@class", SqlDbType.NVarChar, 60, spec.SqlClass);
        Add(command, "@take", SqlDbType.Int, 0, take + 1);
        var names = new List<string>();
        try
        {
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token)) names.Add(reader.GetString(0));
        }
        catch (SqlException sql) when (sql.Number is 15406 or 15517 or 15151)
        {
            var (facts, _) = await LoginAsync(connection, target.Name!, null, null, token);
            return facts is null ? new(null, 0, Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."))
                : new(null, 0, Error("PERMISSION_DENIED", catalog.Logins.Securables.EffectiveDenied));
        }
        return new(null, 0, EffectivePermissions: new([.. names.Take(take)], names.Count > take));
    }

    /// <summary>The Effective tab's request: a login target Login Properties may open on, other than SQL Server's own (whose Securables page
    /// is hidden), and a securable of the catalogue with a name of at most 128 UTF-16 units exactly when it is not the server.</summary>
    private ObjectRefDto EffectiveTarget(ActionDescribeArgs args)
    {
        if (args.Securable is not { } securable || catalog.Logins.Securables.Type(securable.Type) is null
            || (securable.Type == "server" ? securable.Name is not null : !ExplorerRefs.Ident(securable.Name))) throw Invalid("securable.");
        if (args.Target?.Kind != "login" || args.Target.Name is { } name && LoginRules.SystemName(name)) throw Invalid("target.");
        return Target(args.Target, "loginProperties");
    }

    /// <summary>The permission statements a request carries, as Script shows them, in the order they run.</summary>
    private List<string> PermissionStatements(string login, IReadOnlyList<PermissionDto>? permissions) =>
        [.. PermissionSql.Ordered(catalog.Logins.Securables, permissions ?? []).Select(permission => PermissionSql.Statement(catalog.Logins.Securables, login, permission))];

    /// <summary>The run's permission steps, in the order they run, each through <paramref name="run"/> (New Login runs them as they are,
    /// Login Properties bound to the login its preflight read).</summary>
    private List<RunStep> PermissionSteps(IReadOnlyList<PermissionDto>? permissions, Func<PermissionDto, StepContext, Task> run) =>
        [.. PermissionSql.Ordered(catalog.Logins.Securables, permissions ?? []).Select(permission =>
            new RunStep(PermissionSql.StepTitle(permission), context => run(permission, context), Detail: PermissionSql.StepDetail(permission)))];

    /// <summary>Runs (or dry-runs) one permission batch (PermissionSql.Executable) in master: @p1 the login, @p2 the securable's name.</summary>
    private async Task<List<string?>> PermissionAsync(SqlConnection connection, string login, PermissionDto permission, bool dryRun, CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = PermissionSql.Executable(catalog.Logins.Securables, permission, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, login);
        if (permission.Securable.Name is { } name) Add(command, "@p2", SqlDbType.NVarChar, 128, name);
        return await ReadValuesAsync(command, token);
    }

    /// <summary>The live checks' only way to see the statement SQL Server would build for a permission (see DryRunCreateLoginAsync). Not
    /// reachable from the wire.</summary>
    internal async Task<string?> DryRunPermissionAsync(string connectionId, string login, PermissionDto permission, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return (await PermissionAsync(connection, login, permission, dryRun: true, token)).SingleOrDefault();
    }
}

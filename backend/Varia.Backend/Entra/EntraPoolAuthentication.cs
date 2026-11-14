using Microsoft.Data.SqlClient;

namespace Varia.Backend.Entra;

/// <summary>One callback instance per verified target is SqlClient's private pool key, without changing APP_NAME().
/// Original authentication inputs stay here; only the callback-compatible physical string reaches SqlClient.</summary>
internal sealed class EntraPoolAuthentication
{
    private readonly SqlAuthenticationMethod method;
    private readonly string user;
    private readonly string password;
    private readonly string principal;
    private readonly EntraService service;

    internal EntraPoolAuthentication(EntraService service, string connectionString, string principal)
    {
        var builder = new SqlConnectionStringBuilder(connectionString);
        this.service = service;
        method = builder.Authentication;
        user = builder.UserID;
        password = builder.Password;
        this.principal = principal;
        Callback = AcquireAsync;
    }

    internal Func<SqlAuthenticationParameters, CancellationToken, Task<SqlAuthenticationToken>> Callback { get; }

    internal SqlConnection Configure(SqlConnection connection)
    {
        var builder = new SqlConnectionStringBuilder(connection.ConnectionString);
        builder.Remove("Authentication");
        builder.Remove("Password");
        connection.ConnectionString = builder.ConnectionString;
        connection.AccessTokenCallback = Callback;
        return connection;
    }

    private async Task<SqlAuthenticationToken> AcquireAsync(SqlAuthenticationParameters parameters, CancellationToken token)
    {
        // A pool-maintenance callback has no authorized scope. Another target's scope cannot authorize this callback.
        var expected = EntraConnectScope.ExpectedPrincipal == principal ? principal : null;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token, EntraConnectScope.Token);
        using var scope = new EntraConnectScope(budget.Token, expected);
        return await service.Provider.AcquireTokenAsync(new(method, parameters.ServerName, parameters.DatabaseName,
            parameters.Resource, parameters.Authority, user, password, parameters.ConnectionId, parameters.ConnectionTimeout)).ConfigureAwait(false);
    }
}

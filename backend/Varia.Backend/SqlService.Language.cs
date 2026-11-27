using Microsoft.Data.SqlClient;
using System.Text.Json;
using Varia.Backend.Language;

namespace Varia.Backend;

internal sealed partial class SqlService
{
    private LanguageStatus GetLanguageStatus(JsonElement parameters, JsonSerializerOptions json)
    {
        _ = Read<LanguageStatusArgs>(parameters, json);
        return language.Status();
    }

    private async Task<object> ExecuteActionWithLanguagePausedAsync(ActionArgs args, CancellationToken token, Action<object>? progress)
    {
        using var suspension = language.Suspend();
        try { return await CaptureBindingChangesAsync(() => actions.ExecuteAsync(args, token, progress)); }
        // An object action or Table Designer's save ran DDL (or may have, part way): the index checks the database at its next use;
        // one on the server's own objects (a login, a database, an Agent job) checks the server's.
        finally
        {
            // A database's own action (properties, rename, drop) changes the server's list of databases and the database itself.
            if (args.Target.Kind == "database")
            {
                search.MarkSqlStale(args.ConnectionId, null);
                if (args.Target.Name is { Length: > 0 } name) search.MarkSqlStale(args.ConnectionId, name);
            }
            else search.MarkSqlStale(args.ConnectionId, args.Target.Database);
        }
    }

    /// <summary>Resolves only an existing Varia connection. The renderer cannot supply credentials or executable paths.
    /// Entra's token providers live in this backend and cannot be inherited by SQL Tools Service's separate process.</summary>
    internal string? LanguageConnectionString(LanguageContext context)
    {
        if (context.ConnectionId is null) return null;
        if (!connections.TryGetValue(context.ConnectionId, out var text)) throw new RequestException("NOT_CONNECTED", "Connect this query before requesting database IntelliSense.");
        var builder = new SqlConnectionStringBuilder(text);
        if (builder.Authentication is not (SqlAuthenticationMethod.NotSpecified or SqlAuthenticationMethod.SqlPassword))
            throw new RequestException("AUTH_UNSUPPORTED", "SQL language services currently support SQL Server and Windows authentication. Microsoft Entra token sharing with SQL Tools Service is not implemented yet.");
        builder.InitialCatalog = context.Database ?? DatabaseOf(context.ConnectionId, text) ?? builder.InitialCatalog;
        builder.ApplicationName = "Varia SQL Manager IntelliSense";
        builder.Pooling = false;
        return builder.ConnectionString;
    }
}

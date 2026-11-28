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

    /// <summary>Resolves the active database for an in-process ScriptDom + IndexLookup request (completion, hover, refresh).
    /// Verifies the connection exists and supports SQL Login, Windows, and Microsoft Entra ID authentication.</summary>
    internal string? LanguageActiveDatabase(LanguageContext context)
    {
        if (context.ConnectionId is null) return context.Database;
        if (!connections.TryGetValue(context.ConnectionId, out var text))
            throw new RequestException("NOT_CONNECTED", "Connect this query before requesting database IntelliSense.");
        return context.Database ?? DatabaseOf(context.ConnectionId, text);
    }

    /// <summary>Refreshes Search Objects index metadata for the query's connection and database on Ctrl+Shift+R.
    /// Works across all authentication modes including Microsoft Entra ID using Varia's own connection pool.</summary>
    internal async Task<bool> RefreshLanguageIndexAsync(LanguageContext context, CancellationToken token)
    {
        if (context.ConnectionId is not { } connectionId) return false;
        if (!connections.TryGetValue(connectionId, out var text))
            throw new RequestException("NOT_CONNECTED", "Connect this query before refreshing IntelliSense.");
        var database = context.Database ?? DatabaseOf(connectionId, text);
        var status = search.IndexStatus(new ObjectIndexStatusArgs(connectionId)).Status;
        if (status.State == "none" && status.Databases == 0)
        {
            await search.IndexAsync(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString("D")), token);
            return true;
        }
        if (!string.IsNullOrEmpty(database))
        {
            search.MarkSqlStale(connectionId, database);
            await search.IndexAsync(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString("D"), Stale: true, Database: database), token);
        }
        else
        {
            await search.IndexAsync(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString("D"), Stale: true, CheckAll: true), token);
        }
        return true;
    }

    /// <summary>Resolves only an existing Varia connection for SQL Tools Service diagnostics (Phase 2 retires STS completely).
    /// Entra's token providers live in this backend and cannot be inherited by SQL Tools Service's separate process.</summary>
    internal string? LanguageConnectionString(LanguageContext context)
    {
        if (context.ConnectionId is null) return null;
        if (!connections.TryGetValue(context.ConnectionId, out var text)) throw new RequestException("NOT_CONNECTED", "Connect this query before requesting database IntelliSense.");
        var builder = new SqlConnectionStringBuilder(text);
        if (builder.Authentication is not (SqlAuthenticationMethod.NotSpecified or SqlAuthenticationMethod.SqlPassword))
            throw new RequestException("AUTH_UNSUPPORTED", "SQL error checking (SQL Tools Service) is not yet available for Microsoft Entra ID connections. Completion, hover and cache refresh are active via ScriptDom + Index.");
        builder.InitialCatalog = context.Database ?? DatabaseOf(context.ConnectionId, text) ?? builder.InitialCatalog;
        builder.ApplicationName = "Varia SQL Manager IntelliSense";
        builder.Pooling = false;
        return builder.ConnectionString;
    }
}

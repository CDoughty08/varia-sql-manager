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
        return await actions.ExecuteAsync(args, token, progress);
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

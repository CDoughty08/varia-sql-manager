using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Varia.Backend;

/// <summary>Nonsecret evidence of the account that actually authenticated, independent of its mutable display name.</summary>
internal static class ConnectionPrincipal
{
    internal const int MaxTokenLength = 64 * 1024;
    internal const string ProbeSidSql = "SELECT SUSER_SID();";
    internal const string ChangedMessage = "The account used by this connection changed or could not be verified. Disconnect, then connect again to choose the account.";

    /// <summary>A private pool key: unrelated authenticated targets never inherit each other's physical Entra session.
    /// Put it first so a role's bounded application-name suffix cannot truncate it. This string stays in the backend.</summary>
    internal static string IsolatePool(string connectionString, string targetId)
    {
        var builder = new SqlConnectionStringBuilder(connectionString);
        var prefix = "Varia#" + Guid.Parse(targetId).ToString("N") + " ";
        // Leave room for the longest internal role suffix, which remains visible to the own-session ledger.
        builder.ApplicationName = prefix + builder.ApplicationName[..Math.Min(builder.ApplicationName.Length, 88 - prefix.Length)];
        return builder.ConnectionString;
    }

    internal static void Match(string expected, string? actual)
    {
        if (expected != actual) throw new RequestException("AUTH_IDENTITY", ChangedMessage);
    }

    internal static string? FromSid(byte[]? sid) => sid is { Length: > 0 and <= 85 } ? "sid:" + Convert.ToHexStringLower(sid) : null;

    /// <summary>The identity-only fallback does not depend on optional engine/version/capability metadata or privileges.</summary>
    internal static async Task<string?> ProbeSidAsync(SqlConnection connection, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ProbeSidSql;
            command.CommandTimeout = 15;
            return FromSid(await command.ExecuteScalarAsync(token) as byte[]);
        }
        catch (SqlException) { token.ThrowIfCancellationRequested(); return null; }
    }

    /// <summary>Reads only oid/tid from the exact token our trusted provider supplies. This does not validate a token or
    /// establish authentication: the evidence is usable only after SQL Server accepts that same connection's token.
    /// Tokens, payloads, names and groups are never retained, returned or used as identity fallbacks.</summary>
    internal static string? FromEntraToken(string? token)
    {
        if (token is not { Length: > 0 and <= MaxTokenLength }) return null;
        var first = token.IndexOf('.');
        var last = token.LastIndexOf('.');
        if (first <= 0 || last <= first + 1 || last == token.Length - 1 || token.IndexOf('.', first + 1) != last) return null;
        var payload = token[(first + 1)..last];
        if (payload.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))) return null;
        try
        {
            var base64 = payload.Replace('-', '+').Replace('_', '/');
            using var json = JsonDocument.Parse(Convert.FromBase64String(base64.PadRight((base64.Length + 3) / 4 * 4, '=')), new JsonDocumentOptions { MaxDepth = 8 });
            if (json.RootElement.ValueKind != JsonValueKind.Object) return null;
            Guid? tenant = null, subject = null;
            foreach (var property in json.RootElement.EnumerateObject())
            {
                if (property.Name is not ("tid" or "oid")) continue;
                if (property.Value.ValueKind != JsonValueKind.String || !Guid.TryParseExact(property.Value.GetString(), "D", out var id) || id == Guid.Empty) return null;
                if (property.Name == "tid") { if (tenant is not null) return null; tenant = id; }
                else { if (subject is not null) return null; subject = id; }
            }
            return tenant is { } tid && subject is { } oid ? $"entra:{tid:D}:{oid:D}" : null;
        }
        catch (Exception error) when (error is FormatException or JsonException) { return null; }
    }

    internal static string Require(string? principal) => principal ?? throw new RequestException("AUTH_IDENTITY",
        "The server authenticated the connection, but its account identity could not be verified. Reconnect after checking the sign-in and server permissions.");
}

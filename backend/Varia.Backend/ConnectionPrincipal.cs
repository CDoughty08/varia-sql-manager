using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Varia.Backend;

/// <summary>Nonsecret evidence of the account that actually authenticated, independent of its mutable display name.</summary>
internal static class ConnectionPrincipal
{
    internal const int MaxTokenLength = 64 * 1024;
    internal const string ProbeSidSql = "SELECT SUSER_SID();";
    internal const string ChangedMessage = "The account used by this connection changed or could not be verified. Disconnect, then connect again to choose the account.";

    internal static void Match(string expected, string? actual)
    {
        if (expected != actual) throw new RequestException("AUTH_IDENTITY", ChangedMessage);
    }

    internal static string? FromSid(byte[]? sid) => sid is { Length: > 0 and <= 85 } ? "sid:" + Convert.ToHexStringLower(sid) : null;

    /// <summary>The identity-only fallback does not depend on optional engine/version/capability metadata or privileges.</summary>
    internal static Task<string?> ProbeSidAsync(SqlConnection connection, CancellationToken token) => ProbeSidAsync(connection, token, null);

    internal static async Task<string?> ProbeSidAsync(SqlConnection connection, CancellationToken token,
        Func<SqlCommand, CancellationToken, Task<object?>>? execute)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ProbeSidSql;
            command.CommandTimeout = 15;
            return FromSid(await (execute is null ? command.ExecuteScalarAsync(token) : execute(command, token)) as byte[]);
        }
        // An unanswered probe is not evidence of a different account. Preserve transport, timeout and permission errors.
        catch (SqlException) { token.ThrowIfCancellationRequested(); throw; }
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

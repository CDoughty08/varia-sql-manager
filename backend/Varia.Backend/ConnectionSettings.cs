using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Entra;

namespace Varia.Backend;

internal static class ConnectionSettings
{
    private static string Text(string? value, int length, string field)
    {
        if (value is null || value.Length > length) throw new RequestException("INVALID_PARAMS", field + " exceeds its supported length.");
        return value;
    }
    /// <summary>The bounds main's zod schema sets: 1 to 32 characters after trimming, with no control, format, line or
    /// paragraph separator character, which could hide or reorder what the tag shows or break its line.</summary>
    internal static bool IsEnvironmentLabel(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length is 0 or > 32) return false;
        foreach (var rune in trimmed.EnumerateRunes())
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) return false;
        return true;
    }
    internal static SqlConnectionStringBuilder Build(ConnectOptions options)
    {
        if (!EntraModes.IsKnown(options.Authentication)) throw new RequestException("INVALID_PARAMS", "Unsupported authentication mode.");
        if (string.IsNullOrWhiteSpace(options.Server)) throw new RequestException("INVALID_PARAMS", "Server name is required.");
        var advanced = options.Advanced ?? new();
        if (advanced.CommandTimeout is < 0 or > 86400 || advanced.ConnectTimeout is < 0 or > 3600
            || advanced.PacketSize is < 512 or > 32767 || advanced.ConnectRetryCount is < 0 or > 255 || advanced.ConnectRetryInterval is < 1 or > 60)
            throw new RequestException("INVALID_PARAMS", "Connection timeout, packet size, or retry settings are outside their supported range.");
        if (advanced.SecureEnclaves && !advanced.ColumnEncryption) throw new RequestException("INVALID_PARAMS", "Secure enclaves require Always Encrypted.");
        if (advanced.SecureEnclaves && advanced.AttestationProtocol is "HGS" or "AAS" && string.IsNullOrWhiteSpace(advanced.EnclaveAttestationUrl))
            throw new RequestException("INVALID_PARAMS", "An attestation URL is required for HGS or AAS.");
        if (options.Environment is { } environment && !IsEnvironmentLabel(environment))
            throw new RequestException("INVALID_PARAMS", "Environment exceeds its supported length or contains control or formatting characters.");
        var server = Text(options.Server.Trim(), 256, "Server name");
        if (advanced.NetworkProtocol != "default")
        {
            if (advanced.NetworkProtocol is not ("tcp" or "np" or "lpc")) throw new RequestException("INVALID_PARAMS", "Unsupported network protocol.");
            if (server.StartsWith("tcp:", StringComparison.OrdinalIgnoreCase) || server.StartsWith("np:", StringComparison.OrdinalIgnoreCase) || server.StartsWith("lpc:", StringComparison.OrdinalIgnoreCase)) server = server[(server.IndexOf(':') + 1)..];
            server = advanced.NetworkProtocol + ":" + server;
        }
        try
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = server, InitialCatalog = Text(options.Database, 128, "Database"), IntegratedSecurity = options.Authentication == "windows",
                Encrypt = options.Encrypt switch { "optional" => SqlConnectionEncryptOption.Optional, "mandatory" => SqlConnectionEncryptOption.Mandatory, "strict" => SqlConnectionEncryptOption.Strict, _ => throw new RequestException("INVALID_PARAMS", "Unsupported encryption mode.") },
                TrustServerCertificate = options.Encrypt != "strict" && options.TrustServerCertificate,
                HostNameInCertificate = Text(options.HostNameInCertificate ?? "", 256, "Host name in certificate"),
                CommandTimeout = advanced.CommandTimeout, ConnectTimeout = advanced.ConnectTimeout, ConnectRetryCount = advanced.ConnectRetryCount, ConnectRetryInterval = advanced.ConnectRetryInterval,
                ApplicationName = Text(advanced.ApplicationName, 128, "Application name"), WorkstationID = Text(advanced.WorkstationId, 128, "Workstation ID"),
                MultipleActiveResultSets = advanced.MultipleActiveResultSets, PacketSize = advanced.PacketSize,
                TransactionBinding = advanced.TransactionBinding, TypeSystemVersion = advanced.TypeSystemVersion,
                ApplicationIntent = advanced.ApplicationIntent switch { "ReadWrite" => ApplicationIntent.ReadWrite, "ReadOnly" => ApplicationIntent.ReadOnly, _ => throw new RequestException("INVALID_PARAMS", "Unsupported application intent.") },
                CurrentLanguage = Text(advanced.CurrentLanguage, 128, "Current language"), Replication = advanced.Replication,
                IPAddressPreference = advanced.IpAddressPreference switch { "IPv4First" => SqlConnectionIPAddressPreference.IPv4First, "IPv6First" => SqlConnectionIPAddressPreference.IPv6First, "UsePlatformDefault" => SqlConnectionIPAddressPreference.UsePlatformDefault, _ => throw new RequestException("INVALID_PARAMS", "Unsupported IP address preference.") },
                ServerCertificate = Text(advanced.ServerCertificate, 1024, "Server certificate"), AttachDBFilename = Text(advanced.AttachDbFilename, 1024, "Attach DB filename"),
                FailoverPartner = Text(advanced.FailoverPartner, 256, "Failover partner"), FailoverPartnerSPN = Text(advanced.FailoverPartnerSpn, 512, "Failover partner SPN"),
                MultiSubnetFailover = advanced.MultiSubnetFailover, ServerSPN = Text(advanced.ServerSpn, 512, "Server SPN"), UserInstance = advanced.UserInstance,
                ColumnEncryptionSetting = advanced.ColumnEncryption ? SqlConnectionColumnEncryptionSetting.Enabled : SqlConnectionColumnEncryptionSetting.Disabled,
                PersistSecurityInfo = false
            };
            if (advanced.SecureEnclaves)
            {
                builder.AttestationProtocol = advanced.AttestationProtocol switch { "None" => SqlConnectionAttestationProtocol.None, "HGS" => SqlConnectionAttestationProtocol.HGS, "AAS" => SqlConnectionAttestationProtocol.AAS, _ => throw new RequestException("INVALID_PARAMS", "Unsupported attestation protocol.") };
                builder.EnclaveAttestationUrl = Text(advanced.EnclaveAttestationUrl, 2048, "Attestation URL");
            }
            if (options.Authentication == "sql")
            {
                if (string.IsNullOrWhiteSpace(options.Username)) throw new RequestException("INVALID_PARAMS", "SQL authentication requires a username.");
                builder.UserID = Text(options.Username, 128, "Username");
                builder.Password = Text(options.Password ?? "", 1024, "Password");
            }
            else if (EntraModes.IsEntra(options.Authentication)) Entra(builder, options);
            // Force provider validation before opening a server connection.
            using var validated = new SqlConnection(builder.ConnectionString);
            return builder;
        }
        catch (ArgumentException error) { throw new RequestException("INVALID_PARAMS", "Invalid connection properties: " + error.Message); }
    }
    /// <summary>SqlClient's Authentication keyword (every pool inherits it with the connection string) and only the fields
    /// the type uses: a user name or client ID where it names one, and a password only for Entra Password and Service
    /// Principal, so a password sent with any other type never reaches SqlClient.</summary>
    private static void Entra(SqlConnectionStringBuilder builder, ConnectOptions options)
    {
        var mode = options.Authentication;
        // The provider exists before SqlClient ever needs it for this method.
        _ = EntraService.Shared;
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
        builder.Authentication = EntraModes.Method(mode);
#pragma warning restore CS0618
        var user = options.Username;
        if (EntraModes.RequiresUser(mode))
        {
            if (string.IsNullOrWhiteSpace(user)) throw new RequestException("INVALID_PARAMS", mode == "entraServicePrincipal" ? "Microsoft Entra Service Principal requires the application (client) ID in User name." : "Microsoft Entra Password requires a user name.");
            builder.UserID = Text(user, 128, "User name");
        }
        else if (mode != "entraIntegrated" && !string.IsNullOrWhiteSpace(user)) builder.UserID = Text(user, 128, "User name");
        if (!EntraModes.UsesPassword(mode)) return;
        var secret = Text(options.Password ?? "", 1024, "Password");
        if (secret.Length == 0) throw new RequestException("INVALID_PARAMS", mode == "entraServicePrincipal" ? "Microsoft Entra Service Principal requires the client secret in Password." : "Microsoft Entra Password requires a password.");
        builder.Password = secret;
    }

    /// <summary>The Connection String tab: what SqlClient builds, with the password (or client secret) of every type that
    /// takes one shown as &lt;not included&gt;, typed or not (main may fill in a remembered one).</summary>
    internal static object Preview(ConnectOptions options)
    {
        const string omitted = "<not included>";
        var takesPassword = EntraModes.UsesPassword(options.Authentication);
        var builder = Build(takesPassword ? options with { Password = omitted } : options);
        if (takesPassword) builder.Password = omitted;
        return new { ConnectionString = builder.ConnectionString };
    }
}

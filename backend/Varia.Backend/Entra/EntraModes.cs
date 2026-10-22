using Microsoft.Data.SqlClient;

namespace Varia.Backend.Entra;

/// <summary>The Connect dialog's authentication types, as src/shared/auth.ts lists them (tests/auth-modes.test.ts reads
/// these arrays and compares them with it).</summary>
internal static class EntraModes
{
    internal static readonly string[] Known = ["windows", "sql", "entraMfa", "entraPassword", "entraIntegrated", "entraServicePrincipal", "entraManagedIdentity", "entraDefault"];
    /// <summary>The types whose Password is sent (for Service Principal, the client secret); no other type sends one.</summary>
    internal static readonly string[] Password = ["sql", "entraPassword", "entraServicePrincipal"];
    /// <summary>The types that need a user name (for Service Principal, the application's client ID).</summary>
    internal static readonly string[] RequiredUser = ["sql", "entraPassword", "entraServicePrincipal"];

    internal static bool IsKnown(string? mode) => Array.IndexOf(Known, mode) >= 0;
    internal static bool IsEntra(string? mode) => IsKnown(mode) && mode!.StartsWith("entra", StringComparison.Ordinal);
    internal static bool UsesPassword(string? mode) => Array.IndexOf(Password, mode) >= 0;
    internal static bool RequiresUser(string? mode) => Array.IndexOf(RequiredUser, mode) >= 0;

#pragma warning disable CS0618 // SqlClient 7 marks ActiveDirectoryPassword obsolete; SSMS 22 still offers Microsoft Entra Password.
    /// <summary>SqlClient's authentication method for an Entra type; connection strings carry it, so every pool inherits it.</summary>
    internal static SqlAuthenticationMethod Method(string mode) => mode switch
    {
        "entraMfa" => SqlAuthenticationMethod.ActiveDirectoryInteractive,
        "entraPassword" => SqlAuthenticationMethod.ActiveDirectoryPassword,
        "entraIntegrated" => SqlAuthenticationMethod.ActiveDirectoryIntegrated,
        "entraServicePrincipal" => SqlAuthenticationMethod.ActiveDirectoryServicePrincipal,
        "entraManagedIdentity" => SqlAuthenticationMethod.ActiveDirectoryManagedIdentity,
        "entraDefault" => SqlAuthenticationMethod.ActiveDirectoryDefault,
        _ => throw new ArgumentOutOfRangeException(nameof(mode))
    };

    /// <summary>The methods Varia's provider serves: the six above and ActiveDirectoryMSI, SqlClient's older name for Managed
    /// Identity. Device code flow and workload identity, which SSMS does not offer, stay without a provider.</summary>
    internal static readonly SqlAuthenticationMethod[] Methods =
    [
        SqlAuthenticationMethod.ActiveDirectoryInteractive, SqlAuthenticationMethod.ActiveDirectoryPassword, SqlAuthenticationMethod.ActiveDirectoryIntegrated,
        SqlAuthenticationMethod.ActiveDirectoryServicePrincipal, SqlAuthenticationMethod.ActiveDirectoryManagedIdentity, SqlAuthenticationMethod.ActiveDirectoryMSI,
        SqlAuthenticationMethod.ActiveDirectoryDefault
    ];
#pragma warning restore CS0618
}

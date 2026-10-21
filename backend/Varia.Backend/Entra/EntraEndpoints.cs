using System.Text.RegularExpressions;

namespace Varia.Backend.Entra;

/// <summary>Where Varia signs in and what it asks a token for. The server names both during login, so a hostile server
/// could otherwise send the web browser to a sign-in page of its own, or obtain a token for another API: only Microsoft
/// Entra's sign-in addresses in the public, US Government and China clouds, and only SQL audiences, are accepted.</summary>
internal static partial class EntraEndpoints
{
    internal static readonly string[] AuthorityHosts = ["login.microsoftonline.com", "login.windows.net", "login.microsoftonline.us", "login.chinacloudapi.cn", "login.partner.microsoftonline.cn"];
    internal static readonly string[] Resources = ["https://database.windows.net/", "https://database.usgovcloudapi.net/", "https://database.chinacloudapi.cn/", "https://sql.azuresynapse.net/", "https://database.fabric.microsoft.com/"];
    private const string DefaultScope = "/.default";

    // A tenant ID (GUID), a verified domain, or common/organizations: letters, digits, dots, hyphens and underscores.
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex TenantPattern();

    /// <summary>The server's authority (https://login.microsoftonline.com/{tenant}, or an older …/{tenant}/oauth2/authorize):
    /// its host, when it is an allowed one over https on the default port, and the tenant, its first path segment.</summary>
    internal static bool TryParseAuthority(string? authority, out Uri host, out string tenant)
    {
        host = null!;
        tenant = "";
        if (authority is null || authority.Length > 2048 || !Uri.TryCreate(authority, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length > 0 || !IsAllowedHost(uri.Host)) return false;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || !TenantPattern().IsMatch(segments[0])) return false;
        host = new Uri("https://" + uri.Host.ToLowerInvariant() + "/");
        tenant = segments[0];
        return true;
    }

    private static bool IsAllowedHost(string host) => Array.Exists(AuthorityHosts, allowed => string.Equals(allowed, host, StringComparison.OrdinalIgnoreCase));

    /// <summary>A SQL audience, compared without case, with or without its trailing slash or /.default.</summary>
    internal static bool IsAllowedResource(string? resource)
    {
        if (string.IsNullOrEmpty(resource) || resource.Length > 2048) return false;
        var value = resource.EndsWith(DefaultScope, StringComparison.OrdinalIgnoreCase) ? resource[..^DefaultScope.Length] : resource;
        value = value.TrimEnd('/');
        return Array.Exists(Resources, allowed => string.Equals(allowed.TrimEnd('/'), value, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The scope a token is requested for, exactly as SqlClient's own provider writes it.</summary>
    internal static string Scope(string resource) => resource.EndsWith(DefaultScope, StringComparison.Ordinal) ? resource : resource + DefaultScope;

    /// <summary>The host a refused address names, for the message: a DNS name only (at most 253 characters), else none.</summary>
    internal static string? HostOf(string? address)
    {
        if (address is null || !Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Host.Length is 0 or > 253) return null;
        return HostPattern().IsMatch(uri.Host) ? uri.Host : null;
    }

    [GeneratedRegex("^[A-Za-z0-9.-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex HostPattern();
}

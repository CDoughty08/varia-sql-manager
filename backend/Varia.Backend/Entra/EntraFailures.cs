using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using Microsoft.Identity.Client;

namespace Varia.Backend.Entra;

/// <summary>What a failed Microsoft Entra sign-in tells the user. Codes are MSAL's (MsalError) and Microsoft Entra's
/// AADSTS numbers that this maps; any other failure shows MSAL's or Azure.Identity's own text, which carries the AADSTS
/// code and description, as SSMS shows it through SqlClient. Every message is one bounded line with tokens redacted.</summary>
internal static partial class EntraFailures
{
    internal const int MaxMessage = 2000;
    /// <summary>AADSTS numbers that mean the password or client secret itself was refused (main forgets a remembered one).</summary>
    internal const int InvalidPassword = 50126, InvalidClientSecret = 7000215;

    internal static class Messages
    {
        public const string Cancelled = "Sign-in was cancelled in the browser.";
        public const string BrowserFailed = "Varia SQL Manager could not open your web browser for Microsoft Entra sign-in. Set a default browser (on Linux, install xdg-utils), then connect again.";
        public const string MfaRequired = "This account requires multifactor authentication, which Microsoft Entra Password cannot complete. Use Microsoft Entra MFA.";
        public const string BadPassword = "Microsoft Entra ID rejected the user name or password (AADSTS50126). Check them, then connect again.";
        public const string BadSecret = "The client secret is not valid (AADSTS7000215). Check the secret in Password (Service Principal).";
        public const string NoManagedIdentity = "No managed identity is available on this computer. Microsoft Entra Managed Identity works on Azure VMs and other Azure hosts.";
        public const string DefaultNoIdentity = "Microsoft Entra Default found no signed-in identity. Sign in with the Azure CLI (az login), Visual Studio or Visual Studio Code, then connect again.";
        public const string IntegratedNeedsWindows = "Microsoft Entra Integrated needs Windows. On Linux and macOS use Microsoft Entra MFA or Microsoft Entra Default.";
        public const string SignInExpired = "Your Microsoft Entra sign-in for this server has expired or was revoked. Disconnect, then connect again to sign in.";
        public const string TimedOut = "Sign-in in the web browser did not finish within 3 minutes. Connect again to sign in.";
        public const string TokenTimedOut = "Microsoft Entra ID did not issue a token within the connect timeout. Try again.";
        public const string OtherAccount = "The account you signed in with in the browser is not the user name entered. Enter that account's user name, or leave User name empty, then connect again.";
        public const string ClearedDuringSignIn = "The Microsoft Entra ID token cache was cleared while the browser sign-in was waiting. Connect again to sign in.";
        public const string ClearCacheHint =" If you were recently granted access, choose Help › Clear Entra ID Token Cache, then connect again.";
        public const string SignInFailed = "Microsoft Entra sign-in failed.";

        public static string RefusedAuthority(string? host) => "The server asked to sign in at " + (host ?? "an unknown address")
            + ", which is not a Microsoft Entra sign-in address. Varia SQL Manager signs in only at Microsoft Entra addresses.";
        public static string RefusedResource(string? host) => "The server asked for a token for " + (host ?? "an unknown resource")
            + ", which is not an Azure SQL resource. Varia SQL Manager requests Microsoft Entra tokens only for Azure SQL.";
    }

    /// <summary>The failure to record for an exception from MSAL or Azure.Identity.</summary>
    internal static EntraFailure Map(Exception error, SqlAuthenticationMethod method)
    {
        if (Find<EntraBrowserException>(error) is not null) return new("AUTH_ENTRA", Messages.BrowserFailed);
        if (Find<MsalException>(error) is { } msal)
        {
            if (msal.ErrorCode is MsalError.AuthenticationCanceledError or MsalError.AccessDenied) return new("AUTH_ENTRA", Messages.Cancelled);
            if (msal.ErrorCode is MsalError.LinuxXdgOpen or MsalError.WebviewUnavailable or MsalError.AuthenticationUiFailedError or MsalError.AuthenticationUiFailed)
                return new("AUTH_ENTRA", Messages.BrowserFailed);
            // MSAL's managed identity client found no endpoint that answers (not an Azure host).
            if (msal.ErrorCode == MsalError.ManagedIdentityUnreachableNetwork && method is SqlAuthenticationMethod.ActiveDirectoryManagedIdentity or SqlAuthenticationMethod.ActiveDirectoryMSI)
                return new("AUTH_ENTRA", Messages.NoManagedIdentity);
            var codes = Aadsts(msal);
            if (codes.Contains(InvalidPassword)) return new("AUTH_ENTRA", Messages.BadPassword, InvalidPassword);
            if (codes.Contains(InvalidClientSecret)) return new("AUTH_ENTRA", Messages.BadSecret, InvalidClientSecret);
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
            if (method == SqlAuthenticationMethod.ActiveDirectoryPassword && (codes.Contains(50076) || codes.Contains(50079))) return new("AUTH_ENTRA", Messages.MfaRequired);
#pragma warning restore CS0618
        }
        if (Find<CredentialUnavailableException>(error) is not null)
        {
            if (method is SqlAuthenticationMethod.ActiveDirectoryManagedIdentity or SqlAuthenticationMethod.ActiveDirectoryMSI) return new("AUTH_ENTRA", Messages.NoManagedIdentity);
            if (method == SqlAuthenticationMethod.ActiveDirectoryDefault) return new("AUTH_ENTRA", Messages.DefaultNoIdentity);
        }
        // MSAL's message names the AADSTS code and its description; Azure.Identity's leads with the credential's name.
        var text = Sanitize(error.Message);
        return new("AUTH_ENTRA", text.Length == 0 ? Messages.SignInFailed : text, Explained: false);
    }

    /// <summary>The AADSTS numbers a service error names: Microsoft Entra ID leads its error description with them, and MSAL
    /// passes that on in its message (and the response body).</summary>
    internal static HashSet<int> Aadsts(MsalException error)
    {
        var codes = new HashSet<int>();
        foreach (var text in new[] { error.Message, (error as MsalServiceException)?.ResponseBody })
            if (text is not null)
                foreach (Match match in AadstsPattern().Matches(text.Length > 65_536 ? text[..65_536] : text))
                    if (int.TryParse(match.Groups[1].ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture, out var number)) codes.Add(number);
        return codes;
    }

    /// <summary>One line of at most 2,000 characters: control characters become spaces and anything shaped like a JSON Web
    /// Token (an access, refresh or ID token) is replaced, so no message can carry one.</summary>
    internal static string Sanitize(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        // Tokens go first, over the whole text, so no cut below can leave part of one.
        var redacted = JwtPattern().Replace(text, "<token>");
        var builder = new StringBuilder(Math.Min(redacted.Length, MaxMessage * 2));
        foreach (var rune in redacted.EnumerateRunes())
        {
            if (builder.Length >= MaxMessage * 2) break;
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) builder.Append(' ');
            else builder.Append(rune.ToString());
        }
        var value = Whitespace().Replace(builder.ToString(), " ").Trim();
        if (value.Length <= MaxMessage) return value;
        var cut = MaxMessage - 1;
        if (char.IsHighSurrogate(value[cut - 1])) cut--;
        return value[..cut] + "…";
    }

    /// <summary>The request's answer for a recorded attempt. A sign-in the browser would complete is refused outside the
    /// Connect dialog; <paramref name="details"/> (connect and Load databases only) gives the dialog's Error details.</summary>
    internal static RequestException Describe(EntraAttempt attempt, SqlException? error, string server, bool details)
    {
        if (attempt is InteractionRequired) return new("AUTH_ENTRA", Messages.SignInExpired, details ? Details(null, server) : null);
        var failure = (EntraFailure)attempt;
        var first = error is not null && error.Errors.Count > 0 ? Sanitize(error.Errors[0].Message) : "";
        var message = failure.Explained || first.Length == 0 ? failure.Message : Sanitize(first + " " + failure.Message);
        return new(failure.Code, message, details ? Details(failure.Number, server) : null);
    }

    /// <summary>As Kerberos failures: error 0 (or the AADSTS number that refused a password or secret), state 0, class 11.</summary>
    private static ErrorDetails Details(int? number, string server)
    {
        var bounded = server.Trim();
        return new(number ?? 0, 0, 11, bounded.Length == 0 ? null : bounded.Length > ConnectionFailures.MaxServerLength ? bounded[..ConnectionFailures.MaxServerLength] : bounded);
    }

    /// <summary>Learn's advice for "Login failed for user '&lt;token-identified principal&gt;'" (18456) after a group or access change.</summary>
    internal static RequestException WithClearHint(RequestException failure, string authentication) =>
        failure.Code == "SQL_ERROR" && failure.Details?.Number == 18456 && EntraModes.IsEntra(authentication)
            ? new RequestException(failure.Code, failure.Message + Messages.ClearCacheHint, failure.Details)
            : failure;

    private static T? Find<T>(Exception? error) where T : Exception
    {
        for (; error is not null; error = error.InnerException) if (error is T match) return match;
        return null;
    }

    [GeneratedRegex(@"AADSTS(\d{4,9})", RegexOptions.CultureInvariant)]
    private static partial Regex AadstsPattern();
    // A JSON Web Token's header (base64url of '{"'), with its payload and signature when present.
    [GeneratedRegex(@"eyJ[\w-]+(?:\.[\w-]*){0,2}", RegexOptions.CultureInvariant)]
    private static partial Regex JwtPattern();
    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex Whitespace();
}

using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend;

/// <summary>The state of this computer's Kerberos client, which integrated authentication uses on Linux and macOS.</summary>
internal enum KerberosState { Unknown, LibraryMissing, NoTicket, Expired, Valid }

/// <summary>The default credential cache's state and, when it holds a ticket, its client principal.</summary>
internal readonly record struct KerberosIdentity(KerberosState State, string? Principal);

/// <summary>What a failed connection attempt tells the user: SQL Server's message with its number, state, class and server
/// as details, or, for integrated authentication on Linux and macOS, what to fix in the Kerberos setup.</summary>
internal static class ConnectionFailures
{
    /// <summary>The longest server name the details carry; connection options cap the server name at 256 characters too.</summary>
    internal const int MaxServerLength = 256;
    // SqlClient's managed SNI reports every failure to build the Negotiate token under this procedure, as SqlError 0 class 11
    // whose text ("Cannot generate SSPI context.") says nothing about the cause, so the cause comes from KerberosProbe.
    private const string SspiProcedure = "GenClientContext";

    internal static class Messages
    {
        public const string LibraryMissing = "Windows authentication on Linux uses Kerberos, and the Kerberos library (libgssapi_krb5.so.2) is not installed."
            + " Install it (Debian or Ubuntu: sudo apt install libgssapi-krb5-2 krb5-user; Fedora or RHEL: sudo dnf install krb5-libs krb5-workstation;"
            + " Alpine: sudo apk add krb5), sign in with kinit, then connect again. SQL Server authentication works without it.";
        public const string NoTicket = "Windows authentication on Linux and macOS uses your Kerberos ticket, and there is none."
            + " Sign in with kinit user@REALM (the realm in capitals, such as kinit alice@CONTOSO.COM), check the ticket with klist, then connect again.";
        public const string Expired = "Your Kerberos ticket has expired. Sign in again with kinit (or renew it with kinit -R), check it with klist, then connect again.";
        public const string NoServiceTicket = "Kerberos could not get a ticket for this SQL Server. Check with klist that you have a ticket for the server's realm,"
            + " connect with the server's fully qualified name, and make sure SQL Server's service account has the SPN MSSQLSvc/host:port"
            + " (setspn -L account) or set Server SPN in Advanced properties.";
    }

    /// <summary>Integrated authentication goes through Kerberos (GSSAPI) everywhere but Windows, which uses SSPI.</summary>
    internal static bool UsesKerberos(ConnectOptions options) => options.Authentication == "windows" && !OperatingSystem.IsWindows();

    /// <summary>A connection made from a connected profile (query sessions, Object Explorer, Script As, database and column
    /// lists) uses Kerberos when it uses integrated security off Windows.</summary>
    internal static bool UsesKerberos(SqlConnection connection) => !OperatingSystem.IsWindows() && new SqlConnectionStringBuilder(connection.ConnectionString).IntegratedSecurity;

    /// <summary>The failure to answer for a connection that did not open, or null to leave it to the host's general mapping.
    /// <paramref name="kerberos"/> says the attempt used Kerberos; only then does a token failure call <paramref name="probe"/>.</summary>
    internal static RequestException? Describe(Exception error, string server, bool kerberos, Func<KerberosState> probe)
    {
        if (kerberos && Kerberos(error, server, probe) is { } failure) return failure;
        var sql = Find<SqlException>(error);
        if (sql is null) return null;
        var details = Details(sql, server);
        return new RequestException("SQL_ERROR", sql.Message, Untrusted(error, sql) ? details with { Reason = ErrorDetailsLimits.Certificate } : details);
    }

    // SEC_E_UNTRUSTED_ROOT and SEC_E_WRONG_PRINCIPAL: Windows' SNI reports them as the error number, and the managed SNI
    // (Linux and macOS) reports any certificate its validation rejects as SEC_E_UNTRUSTED_ROOT. Once Host Name in
    // Certificate is set, Windows' SNI reports an untrusted chain as CERT_E_UNTRUSTEDROOT or CERT_E_CHAINING instead.
    // CERT_E_WRONG_USAGE (0x800B0110, what a pinned Server Certificate that does not match reports) stays out: that is a
    // certificate Trust server certificate must not wave through.
    private static readonly HashSet<int> CertificateErrors = [unchecked((int)0x80090325), unchecked((int)0x80090322), unchecked((int)0x800B0109), unchecked((int)0x800B010A)];

    /// <summary>The TLS handshake failed because the server's certificate is not trusted, by its chain or its name: what
    /// Trust server certificate (or Host Name in Certificate) fixes, unless the person pinned the certificate or its name
    /// (connect-fix.ts then explains instead). The managed SNI can also surface it only as the
    /// AuthenticationException that SslStream's validation callback raised.</summary>
    internal static bool Untrusted(Exception error, SqlException sql)
    {
        foreach (SqlError item in sql.Errors)
            if (CertificateErrors.Contains(item.Number)) return true;
        for (Exception? current = error; current is not null; current = current.InnerException)
            if (current is System.Security.Authentication.AuthenticationException && current.Message.Contains("certificate", StringComparison.OrdinalIgnoreCase)
                || current is System.ComponentModel.Win32Exception { NativeErrorCode: var code } && CertificateErrors.Contains(code)) return true;
        return false;
    }

    /// <summary>What to fix when the Kerberos token could not be built, with the failure's details, or null for any other failure.</summary>
    internal static RequestException? Kerberos(Exception error, string server, Func<KerberosState> probe)
    {
        var sql = Find<SqlException>(error);
        if (!IsTokenFailure(error, sql)) return null;
        var state = LibraryNamed(error) ? KerberosState.LibraryMissing : Probe(probe);
        var message = state switch
        {
            KerberosState.LibraryMissing => Messages.LibraryMissing,
            KerberosState.NoTicket => Messages.NoTicket,
            KerberosState.Expired => Messages.Expired,
            _ => Messages.NoServiceTicket
        };
        return new RequestException(state == KerberosState.LibraryMissing ? "AUTH_UNSUPPORTED" : "AUTH_KERBEROS", message, sql is null ? new(null, null, null, Bounded(server)) : Details(sql, server));
    }

    /// <summary>Opens a connection made from a connected profile. A ticket can expire while the workbench stays connected
    /// (MIT's default lifetime is ten hours), and every new session or pooled connection then fails to build the token, so
    /// those opens say what to fix as connect does; without the details, which only the Connect dialog shows. Any other
    /// failure is left to the caller's own handling.</summary>
    internal static Task OpenAsync(SqlConnection connection, CancellationToken token) => OpenAsync(connection, token, UsesKerberos(connection), KerberosProbe.Inspect);

    /// <param name="open">Replaces SqlConnection.OpenAsync (the checks fail it the way SqlClient does).</param>
    internal static async Task OpenAsync(SqlConnection connection, CancellationToken token, bool kerberos, Func<KerberosState> probe, Func<SqlConnection, CancellationToken, Task>? open = null)
    {
        try { await (open is null ? connection.OpenAsync(token) : open(connection, token)); }
        catch (Exception error) when (kerberos && !token.IsCancellationRequested && Kerberos(error, connection.DataSource, probe) is { } failure)
        {
            throw new RequestException(failure.Code, failure.Message);
        }
    }

    private static ErrorDetails Details(SqlException sql, string server)
    {
        // The first error is the one SQL Server (or the client) raised; later ones are context such as "changed database".
        var first = sql.Errors.Count > 0 ? sql.Errors[0] : null;
        var answered = string.IsNullOrWhiteSpace(first?.Server) ? server : first.Server;
        return new(sql.Number, sql.State, sql.Class, Bounded(answered));
    }

    private static string? Bounded(string? server)
    {
        var value = server?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        return value.Length > MaxServerLength ? value[..MaxServerLength] : value;
    }

    private static bool IsTokenFailure(Exception error, SqlException? sql)
    {
        if (sql is not null)
            foreach (SqlError item in sql.Errors)
                if (item.Procedure == SspiProcedure) return true;
        for (Exception? current = error; current is not null; current = current.InnerException)
            if (current is DllNotFoundException || current.Message.Contains("GSSAPI", StringComparison.OrdinalIgnoreCase) || current.Message.Contains("SSPI", StringComparison.Ordinal))
                return true;
        return false;
    }

    /// <summary>An exception that names the missing GSSAPI library (older runtimes and SqlClient builds surfaced it).</summary>
    private static bool LibraryNamed(Exception error)
    {
        for (Exception? current = error; current is not null; current = current.InnerException)
            if (current.Message.Contains("libgssapi", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static KerberosState Probe(Func<KerberosState> probe)
    {
        try { return probe(); }
        catch (Exception error) when (error is not OutOfMemoryException) { return KerberosState.Unknown; }
    }

    private static T? Find<T>(Exception? error) where T : Exception
    {
        for (; error is not null; error = error.InnerException) if (error is T match) return match;
        return null;
    }
}

/// <summary>Asks GSSAPI, as SqlClient's Negotiate token does, whether this user has a usable Kerberos ticket (after a token
/// failure), and whose it is (for the Connect dialog's User Name). Both read the credential cache without contacting the KDC.</summary>
internal static class KerberosProbe
{
    // RFC 2744: the routine error is bits 16-23 of the major status.
    private const uint NoCredentials = 7, CredentialsExpired = 11, Failure = 13;
    private const int Initiate = 1;
    /// <summary>The longest principal the Connect dialog shows; a longer one is cut, with an ellipsis.</summary>
    internal const int MaxPrincipalLength = 256;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint AcquireCredential(out uint minor, IntPtr name, uint lifetimeWanted, IntPtr mechanisms, int usage, out IntPtr credential, IntPtr actualMechanisms, out uint lifetime);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint ReleaseCredential(out uint minor, ref IntPtr credential);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint InquireCredential(out uint minor, IntPtr credential, out IntPtr name, IntPtr lifetime, IntPtr usage, IntPtr mechanisms);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint DisplayName(out uint minor, IntPtr name, ref GssBuffer buffer, IntPtr nameType);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint ReleaseName(out uint minor, ref IntPtr name);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint ReleaseBuffer(out uint minor, ref GssBuffer buffer);

    /// <summary>gss_buffer_desc: a length and a pointer, the same layout in MIT Kerberos and in macOS's GSS framework.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct GssBuffer
    {
        public nuint Length;
        public IntPtr Value;
    }

    /// <summary>The library .NET's own GSSAPI shim loads: MIT Kerberos on Linux, the system GSS framework on macOS.</summary>
    internal static readonly string[] Libraries = OperatingSystem.IsMacOS() ? ["/System/Library/Frameworks/GSS.framework/GSS"] : ["libgssapi_krb5.so.2", "libgssapi_krb5.so"];

    internal static KerberosState Inspect() => Identity(principal: false).State;

    /// <summary>The ticket integrated authentication would use off Windows and, while it is valid, its principal (such as
    /// alice@CONTOSO.COM), as SSMS shows DOMAIN\user: the default initiator credential's name. MIT will not inquire an
    /// expired credential, so only a valid ticket names one; without a ticket or the library there is none.</summary>
    internal static KerberosIdentity Identity() => Identity(principal: true);

    private static KerberosIdentity Identity(bool principal)
    {
        if (OperatingSystem.IsWindows()) return new(KerberosState.Unknown, null);
        var library = IntPtr.Zero;
        foreach (var name in Libraries) if (NativeLibrary.TryLoad(name, out library)) break;
        if (library == IntPtr.Zero) return new(KerberosState.LibraryMissing, null);
        try
        {
            if (!NativeLibrary.TryGetExport(library, "gss_acquire_cred", out var acquire) || !NativeLibrary.TryGetExport(library, "gss_release_cred", out var release)) return new(KerberosState.Unknown, null);
            // The default initiator credential of the default mechanisms: the ticket SqlClient's Negotiate token would use.
            var major = Marshal.GetDelegateForFunctionPointer<AcquireCredential>(acquire)(out _, IntPtr.Zero, 0, IntPtr.Zero, Initiate, out var credential, IntPtr.Zero, out var lifetime);
            try
            {
                var state = Classify(major, lifetime);
                return new(state, principal && state == KerberosState.Valid && credential != IntPtr.Zero ? Bounded(Principal(library, credential)) : null);
            }
            finally { if (credential != IntPtr.Zero) Marshal.GetDelegateForFunctionPointer<ReleaseCredential>(release)(out _, ref credential); }
        }
        finally { NativeLibrary.Free(library); }
    }

    /// <summary>gss_inquire_cred's name of the credential, as gss_display_name writes it (UTF-8), or null.</summary>
    private static string? Principal(IntPtr library, IntPtr credential)
    {
        if (!NativeLibrary.TryGetExport(library, "gss_inquire_cred", out var inquire) || !NativeLibrary.TryGetExport(library, "gss_display_name", out var display)
            || !NativeLibrary.TryGetExport(library, "gss_release_name", out var releaseName) || !NativeLibrary.TryGetExport(library, "gss_release_buffer", out var releaseBuffer)) return null;
        // Optional outputs (lifetime, usage, mechanisms, name type) are passed as NULL, which RFC 2744 allows.
        if (Marshal.GetDelegateForFunctionPointer<InquireCredential>(inquire)(out _, credential, out var name, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) != 0 || name == IntPtr.Zero) return null;
        try
        {
            var buffer = default(GssBuffer);
            if (Marshal.GetDelegateForFunctionPointer<DisplayName>(display)(out _, name, ref buffer, IntPtr.Zero) != 0) return null;
            try
            {
                if (buffer.Value == IntPtr.Zero || buffer.Length == 0) return null;
                // Four bytes per character at most: enough for the longest principal shown, which Bounded then cuts.
                return Marshal.PtrToStringUTF8(buffer.Value, (int)Math.Min(buffer.Length, (nuint)MaxPrincipalLength * 4));
            }
            finally { Marshal.GetDelegateForFunctionPointer<ReleaseBuffer>(releaseBuffer)(out _, ref buffer); }
        }
        finally { Marshal.GetDelegateForFunctionPointer<ReleaseName>(releaseName)(out _, ref name); }
    }

    /// <summary>A principal the dialog can show: none when it is empty or holds control or formatting characters (which could
    /// disguise it); at most 256 characters, a longer one cut with an ellipsis and never inside a surrogate pair.</summary>
    internal static string? Bounded(string? principal)
    {
        var value = principal?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        // By code point, as main's /u rule reads it: a supplementary-plane format character (a tag) is two surrogates as chars.
        foreach (var rune in value.EnumerateRunes())
            if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format) return null;
        if (value.Length <= MaxPrincipalLength) return value;
        var cut = MaxPrincipalLength - 1;
        if (char.IsHighSurrogate(value[cut - 1])) cut--;
        return value[..cut] + "…";
    }

    /// <summary>gss_acquire_cred's answer: MIT reports a missing cache as a failure and an expired ticket as a credential
    /// with no time left; Heimdal reports them as no credentials and expired credentials.</summary>
    internal static KerberosState Classify(uint major, uint lifetime)
    {
        if (major == 0) return lifetime == 0 ? KerberosState.Expired : KerberosState.Valid;
        return ((major >> 16) & 0xff) switch
        {
            CredentialsExpired => KerberosState.Expired,
            NoCredentials or Failure => KerberosState.NoTicket,
            _ => KerberosState.Unknown
        };
    }
}

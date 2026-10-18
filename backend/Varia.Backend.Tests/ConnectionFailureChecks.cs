using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of ConnectionFailures: the details a failed connection carries, and the Kerberos messages for
/// integrated authentication on Linux and macOS, decided by a stubbed probe.</summary>
internal static class ConnectionFailureChecks
{
    /// <summary>A SqlException as SqlClient builds one. Its constructors are internal; a SqlClient upgrade that changes them
    /// fails these checks here rather than silently testing something else.</summary>
    internal static SqlException Sql(int number, byte state, byte level, string server, string message, string procedure = "", Exception? inner = null)
    {
        var flags = BindingFlags.NonPublic | BindingFlags.Instance;
        var error = (SqlError)(typeof(SqlError).GetConstructor(flags, [typeof(int), typeof(byte), typeof(byte), typeof(string), typeof(string), typeof(string), typeof(int), typeof(Exception)])
            ?? throw new Exception("SqlClient's SqlError constructor changed; update ConnectionFailureChecks.Sql")).Invoke([number, state, level, server, message, procedure, 0, inner]);
        var errors = (SqlErrorCollection)(typeof(SqlErrorCollection).GetConstructor(flags, Type.EmptyTypes) ?? throw new Exception("SqlErrorCollection's constructor changed")).Invoke([]);
        (typeof(SqlErrorCollection).GetMethod("Add", flags) ?? throw new Exception("SqlErrorCollection.Add changed")).Invoke(errors, [error]);
        var create = typeof(SqlException).GetMethod("CreateException", BindingFlags.NonPublic | BindingFlags.Static, [typeof(SqlErrorCollection), typeof(string)])
            ?? throw new Exception("SqlException.CreateException changed");
        return (SqlException)create.Invoke(null, [errors, "17.00.1000"])!;
    }

    /// <summary>The argument that makes the check program print KerberosProbe.Inspect() and exit (see RunAsync).</summary>
    internal const string ProbeArgument = "--kerberos-probe";

    /// <summary>What SqlClient's managed SNI raises when the Negotiate token cannot be built (SspiContextProvider.SSPIError).</summary>
    internal static SqlException TokenFailure() => Sql(0, 0, 11, "sql.contoso.com", "The target principal name is incorrect.  Cannot generate SSPI context.", "GenClientContext");

    /// <summary>Opens as SqlService does for a connection made from a connected profile, failing as a Kerberos ticket that
    /// expired during the session does.</summary>
    internal static Task ExpiredTicket(SqlConnection connection, CancellationToken token) =>
        ConnectionFailures.OpenAsync(connection, token, kerberos: true, () => KerberosState.Expired, (_, _) => Task.FromException(TokenFailure()));

    public static async Task RunAsync(Action<bool, string> check)
    {
        var probes = 0;
        Func<KerberosState> Probe(KerberosState state) => () => { probes++; return state; };
        var token = TokenFailure();

        var failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: true, Probe(KerberosState.NoTicket));
        check(failure?.Code == "AUTH_KERBEROS" && failure.Message == ConnectionFailures.Messages.NoTicket && failure.Message.Contains("kinit") && failure.Message.Contains("klist"),
            "integrated authentication without a Kerberos ticket says to run kinit");
        check(failure?.Details == new ErrorDetails(0, 0, 11, "sql.contoso.com"), "a Kerberos failure keeps SqlClient's number, state, class and server as its details");
        failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: true, Probe(KerberosState.Expired));
        check(failure?.Code == "AUTH_KERBEROS" && failure.Message == ConnectionFailures.Messages.Expired && failure.Message.Contains("kinit"), "an expired Kerberos ticket says to sign in again with kinit");
        failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: true, Probe(KerberosState.LibraryMissing));
        check(failure?.Code == "AUTH_UNSUPPORTED" && failure.Message.Contains("libgssapi-krb5-2") && failure.Message.Contains("krb5-libs") && failure.Message.Contains("kinit"),
            "a missing GSSAPI library says which package to install, then kinit");
        failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: true, Probe(KerberosState.Valid));
        check(failure?.Code == "AUTH_KERBEROS" && failure.Message == ConnectionFailures.Messages.NoServiceTicket && failure.Message.Contains("MSSQLSvc/"),
            "with a valid ticket, a token failure points at the server's SPN");
        failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: true, () => throw new EntryPointNotFoundException("gss_acquire_cred"));
        check(failure?.Code == "AUTH_KERBEROS" && failure.Message == ConnectionFailures.Messages.NoServiceTicket, "a probe that fails is answered with the general Kerberos advice, not a crash");

        probes = 0;
        var library = new InvalidOperationException("Cannot generate SSPI context.", new TypeInitializationException("Interop+NetSecurityNative",
            new DllNotFoundException("Unable to load shared library 'libgssapi_krb5.so.2' or one of its dependencies.")));
        failure = ConnectionFailures.Describe(library, " linux-sql ", kerberos: true, Probe(KerberosState.Valid));
        check(failure?.Code == "AUTH_UNSUPPORTED" && failure.Message == ConnectionFailures.Messages.LibraryMissing && probes == 0 && failure.Details == new ErrorDetails(null, null, null, "linux-sql"),
            "an exception naming libgssapi is the missing library without probing, and its details name the server typed");

        probes = 0;
        failure = ConnectionFailures.Describe(token, "sql.contoso.com", kerberos: false, Probe(KerberosState.NoTicket));
        check(failure?.Code == "SQL_ERROR" && failure.Message == token.Message && probes == 0, "Windows (SSPI) keeps SqlClient's own message and never probes Kerberos");
        var login = Sql(18456, 1, 14, "", "Login failed for user 'reader'.");
        failure = ConnectionFailures.Describe(login, "localhost,1433", kerberos: true, Probe(KerberosState.NoTicket));
        check(failure?.Code == "SQL_ERROR" && failure.Message == "Login failed for user 'reader'." && probes == 0 && failure.Details == new ErrorDetails(18456, 1, 14, "localhost,1433"),
            "a login failure is not a Kerberos failure: SQL Server's message, with the typed server when SqlClient names none");
        failure = ConnectionFailures.Describe(Sql(53, 0, 20, new string('s', 400), "A network-related error occurred."), "x", kerberos: false, Probe(KerberosState.Valid));
        check(failure?.Details?.Server?.Length == ConnectionFailures.MaxServerLength, "the details' server name is cut at 256 characters");
        check(ConnectionFailures.Describe(new InvalidOperationException("The pool is closed."), "x", kerberos: true, Probe(KerberosState.NoTicket)) is null && probes == 0,
            "other exceptions are left to the host's general mapping");
        check(!JsonSerializer.Serialize(ConnectionFailures.Describe(login, "localhost", kerberos: false, Probe(KerberosState.Valid))!.Details).Contains("assword", StringComparison.OrdinalIgnoreCase),
            "details hold only the number, state, class and server");

        check(KerberosProbe.Classify(0, 36_000) == KerberosState.Valid && KerberosProbe.Classify(0, uint.MaxValue) == KerberosState.Valid, "a credential with time left is a valid ticket");
        check(KerberosProbe.Classify(0, 0) == KerberosState.Expired, "MIT: a credential with no time left is an expired ticket");
        check(KerberosProbe.Classify(13u << 16, 0) == KerberosState.NoTicket && KerberosProbe.Classify(7u << 16, 0) == KerberosState.NoTicket, "GSS_S_FAILURE (MIT) and GSS_S_NO_CRED (Heimdal) mean no ticket");
        check(KerberosProbe.Classify(11u << 16, 0) == KerberosState.Expired, "GSS_S_CREDENTIALS_EXPIRED means an expired ticket");
        check(KerberosProbe.Classify(1u << 16, 0) == KerberosState.Unknown && KerberosProbe.Classify(1u << 24, 0) == KerberosState.Unknown, "other GSSAPI answers are unknown");
        if (OperatingSystem.IsWindows()) check(KerberosProbe.Inspect() == KerberosState.Unknown, "Windows never probes GSSAPI");

        // Opens made from a connected profile: query sessions, Object Explorer, Script As, database and column lists.
        var stored = new SqlConnection("Data Source=sql.contoso.com;Integrated Security=true;Pooling=false");
        async Task<Exception?> Opened(bool kerberos, Exception failure, CancellationToken cancel = default)
        {
            try { await ConnectionFailures.OpenAsync(stored, cancel, kerberos, Probe(KerberosState.NoTicket), (_, _) => Task.FromException(failure)); return null; }
            catch (Exception error) { return error; }
        }
        probes = 0;
        var opened = await Opened(true, token);
        check(opened is RequestException { Code: "AUTH_KERBEROS", Details: null } && opened.Message == ConnectionFailures.Messages.NoTicket && probes == 1,
            "a session or pool connection that cannot build the Kerberos token says to run kinit, without the Connect dialog's details");
        check(await Opened(false, token) == token && await Opened(true, login) == login && probes == 1,
            "with SSPI, or for a failure that is not Kerberos, a stored connection's open keeps SqlClient's exception for its caller");
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            check(await Opened(true, token, cancelled.Token) == token && probes == 1, "a cancelled open is left to the host, which answers CANCELLED or TIMEOUT");
        }
        opened = await Opened(true, library);
        check(opened is RequestException { Code: "AUTH_UNSUPPORTED" } && opened.Message == ConnectionFailures.Messages.LibraryMissing, "a stored connection without the GSSAPI library says what to install");
        check(ConnectionFailures.UsesKerberos(stored) == !OperatingSystem.IsWindows() && !ConnectionFailures.UsesKerberos(new SqlConnection("Data Source=x;User ID=reader;Password=x")),
            "a stored connection uses Kerberos for integrated security off Windows only");
        check(SqlService.ConnectBuilder(new ConnectOptions("sql.contoso.com", "", "windows", null, null, true)).PoolBlockingPeriod == PoolBlockingPeriod.NeverBlock,
            "connect's settings, which its pools derive from, never block a pool after a failure");

        if (!OperatingSystem.IsWindows()) await NativeProbeAsync(check);
    }

    /// <summary>Runs KerberosProbe.Inspect's native path (dlopen, then gss_acquire_cred through a delegate) in a child
    /// process whose KRB5CCNAME names a cache that cannot exist: .NET does not pass its own environment changes to native
    /// code, and a wrong signature or library path crashes only the child. Linux and macOS CI run it with the other offline
    /// checks.</summary>
    private static async Task NativeProbeAsync(Action<bool, string> check)
    {
        var present = KerberosProbe.Libraries.Any(name =>
        {
            if (!NativeLibrary.TryLoad(name, out var handle)) return false;
            NativeLibrary.Free(handle);
            return true;
        });
        var path = Environment.ProcessPath ?? throw new Exception("The check program's path is unknown");
        var start = new ProcessStartInfo(path) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        if (Path.GetFileNameWithoutExtension(path) == "dotnet") start.ArgumentList.Add(typeof(ConnectionFailureChecks).Assembly.Location);
        start.ArgumentList.Add(ProbeArgument);
        start.Environment["KRB5CCNAME"] = "FILE:/nonexistent/varia-no-ticket-" + Guid.NewGuid().ToString("N");
        using var child = Process.Start(start) ?? throw new Exception("The Kerberos probe did not start");
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try { await child.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException) { child.Kill(true); throw new Exception("The Kerberos probe did not finish in 60 seconds"); }
        var answer = (await output).Trim();
        var expected = present ? nameof(KerberosState.NoTicket) : nameof(KerberosState.LibraryMissing);
        check(child.ExitCode == 0 && answer == expected,
            "GSSAPI's own answer for a credential cache that does not exist is " + expected + " (got '" + answer + "', exit " + child.ExitCode + ", " + (await errors).Trim() + ")");
    }

    /// <summary>Live: two failed opens with connect's settings both reach the server. Under SqlClient's default pool blocking the
    /// second is a clone of the first's exception, with its client connection id, thrown without trying (the control).</summary>
    internal static async Task PoolBlockingAsync(Action<bool, string> check, ConnectOptions rejected)
    {
        static async Task<SqlException> Failed(SqlConnectionStringBuilder settings)
        {
            try
            {
                await using var connection = new SqlConnection(settings.ConnectionString);
                await connection.OpenAsync();
            }
            catch (SqlException error) { return error; }
            throw new Exception("A login that does not exist was accepted");
        }
        var never = SqlService.ConnectBuilder(rejected);
        var blocking = SqlService.ConnectBuilder(rejected);
        blocking.PoolBlockingPeriod = PoolBlockingPeriod.Auto;
        try
        {
            var first = await Failed(never);
            var second = await Failed(never);
            check(first.ClientConnectionId != Guid.Empty && second.ClientConnectionId != first.ClientConnectionId,
                "a second Connect after a failure tries again rather than rethrowing the pool's cached failure");
            var cached = await Failed(blocking);
            check((await Failed(blocking)).ClientConnectionId == cached.ClientConnectionId, "SqlClient's default pool blocking rethrows the first failure without trying (the control)");
        }
        finally
        {
            using (var connection = new SqlConnection(never.ConnectionString)) SqlConnection.ClearPool(connection);
            using (var connection = new SqlConnection(blocking.ConnectionString)) SqlConnection.ClearPool(connection);
        }
    }
}

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

    /// <summary>The argument that makes the check program print KerberosProbe.Identity() as State|Principal and exit.</summary>
    internal const string IdentityArgument = "--kerberos-identity";

    /// <summary>The Connect dialog's User Name under Windows Authentication off Windows: the principal, bounded, from one
    /// lookup at a time, through a stubbed probe.</summary>
    internal static async Task IdentityAsync(Action<bool, string> check)
    {
        check(KerberosProbe.Bounded("  alice@CONTOSO.COM ") == "alice@CONTOSO.COM" && KerberosProbe.Bounded(null) is null && KerberosProbe.Bounded(" ") is null,
            "a principal is shown trimmed, and an empty one is none");
        check(KerberosProbe.Bounded("alice\n@CONTOSO.COM") is null && KerberosProbe.Bounded("‮alice@CONTOSO.COM") is null && KerberosProbe.Bounded("al​ice@X") is null,
            "a principal with control or formatting characters (line breaks, bidi overrides, zero-width spaces) is not shown");
        // Categories are a code point's, as main's /u rule reads them: a supplementary-plane tag character (Cf) is two surrogates.
        check(KerberosProbe.Bounded("alice\U000E0041@X") is null && KerberosProbe.Bounded("\U000E0001alice@X") is null && KerberosProbe.Bounded("\U0001D49Clice@X") == "\U0001D49Clice@X",
            "a principal with a supplementary-plane formatting character is not shown, and one with a supplementary-plane letter is");
        var cut = KerberosProbe.Bounded(new string('a', 300) + "@CONTOSO.COM");
        check(cut?.Length == KerberosProbe.MaxPrincipalLength && cut.EndsWith('…') && cut.StartsWith(new string('a', 255)), "a principal over 256 characters is cut to 256, with an ellipsis");
        var pair = KerberosProbe.Bounded(new string('a', 254) + "\U0001F600" + new string('b', 10));
        check(pair == new string('a', 254) + "…", "a cut never splits a surrogate pair");
        check(KerberosProbe.Bounded(new string('a', 256)) == new string('a', 256), "a principal of exactly 256 characters is shown whole");
        if (OperatingSystem.IsWindows()) check(KerberosProbe.Identity() == new KerberosIdentity(KerberosState.Unknown, null), "Windows never asks GSSAPI for a principal");

        // The backend's own options (Program.cs).
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
        };
        using var service = new SqlService();
        async Task<IntegratedIdentity> Ask(string parameters = "{}") => (IntegratedIdentity)await service.DispatchAsync("connections.identity", JsonDocument.Parse(parameters).RootElement, json);
        service.IdentityProbe = () => new(KerberosState.Valid, "alice@CONTOSO.COM");
        check(await Ask() == new IntegratedIdentity("alice@CONTOSO.COM") && service.LaneOf("connections.identity") == Protocol.RequestLane.Metadata,
            "connections.identity answers the ticket's principal, on the metadata lane");
        try { await Ask("""{"user":"alice"}"""); check(false, "connections.identity accepted an unknown member"); }
        catch (JsonException) { check(true, "connections.identity refuses unknown members, as every method does"); }
        service.IdentityProbe = () => new(KerberosState.Expired, "alice@CONTOSO.COM");
        check((await Ask()).Principal is null, "an expired ticket names no principal: integrated authentication cannot use it");
        service.IdentityProbe = () => new(KerberosState.NoTicket, null);
        var none = await Ask();
        check(none.Principal is null && JsonSerializer.Serialize(none, json) == "{}", "without a ticket the answer has no principal, and the dialog shows the OS user name");
        service.IdentityProbe = () => new(KerberosState.Valid, new string('x', 5000));
        check((await Ask()).Principal?.Length == KerberosProbe.MaxPrincipalLength, "the answer's principal is bounded whatever the probe returns");
        using var release = new ManualResetEventSlim();
        var lookups = 0;
        service.IdentityProbe = () => { Interlocked.Increment(ref lookups); release.Wait(TimeSpan.FromSeconds(30)); return new(KerberosState.Valid, "bob@CONTOSO.COM"); };
        var waiting = Enumerable.Range(0, 5).Select(_ => Ask()).ToList();
        var asked = SpinWait.SpinUntil(() => Volatile.Read(ref lookups) == 1, 5000);
        // A request whose deadline passes stops waiting (freeing its slot) while the lookup goes on for the others.
        using (var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(100)))
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            try { await service.IdentityAsync(new IdentityArgs(), deadline.Token); check(false, "an identity request outlived its deadline"); }
            catch (OperationCanceledException) { check(timer.Elapsed < TimeSpan.FromSeconds(10) && !release.IsSet, "an identity request ends at its deadline while the lookup it waits on is stuck"); }
        }
        release.Set();
        var answers = await Task.WhenAll(waiting);
        check(asked && lookups == 1 && answers.All(answer => answer.Principal == "bob@CONTOSO.COM"), "dialogs asking while a lookup runs share it: a cache that does not answer holds one thread");
        check((await Ask()).Principal == "bob@CONTOSO.COM" && lookups == 2, "a finished lookup is not reused: the next dialog reads the cache again, after kinit or kdestroy");
    }

    /// <summary>Runs KerberosProbe's native paths (dlopen, then gss_acquire_cred, gss_inquire_cred and gss_display_name
    /// through delegates) in child processes whose KRB5CCNAME names the cache to read: .NET does not pass its own environment
    /// changes to native code, and a wrong signature or library path crashes only the child. Linux and macOS CI run them with
    /// the other offline checks; the caches with a ticket are written in MIT's file format, so they run on Linux only.</summary>
    private static async Task NativeProbeAsync(Action<bool, string> check)
    {
        var present = KerberosProbe.Libraries.Any(name =>
        {
            if (!NativeLibrary.TryLoad(name, out var handle)) return false;
            NativeLibrary.Free(handle);
            return true;
        });
        var missing = "FILE:/nonexistent/varia-no-ticket-" + Guid.NewGuid().ToString("N");
        var (exit, answer, errors) = await ChildAsync(ProbeArgument, missing);
        var expected = present ? nameof(KerberosState.NoTicket) : nameof(KerberosState.LibraryMissing);
        check(exit == 0 && answer == expected, "GSSAPI's own answer for a credential cache that does not exist is " + expected + " (got '" + answer + "', exit " + exit + ", " + errors + ")");
        (exit, answer, errors) = await ChildAsync(IdentityArgument, missing);
        check(exit == 0 && answer == expected + "|", "without a ticket GSSAPI names no principal (got '" + answer + "', exit " + exit + ", " + errors + ")");
        if (!OperatingSystem.IsLinux() || !present) return;

        var directory = Directory.CreateTempSubdirectory("varia-krb5-");
        try
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var (name, end, state) in new[] { ("valid", now.AddHours(1), KerberosState.Valid), ("expired", now.AddHours(-1), KerberosState.Expired) })
            {
                var cache = Path.Combine(directory.FullName, name);
                await File.WriteAllBytesAsync(cache, CredentialCache("varia-probe", "VARIA.TEST", end));
                (exit, answer, errors) = await ChildAsync(IdentityArgument, "FILE:" + cache, directory.FullName);
                check(exit == 0 && answer == state + (state == KerberosState.Valid ? "|varia-probe@VARIA.TEST" : "|"),
                    (state == KerberosState.Valid ? "GSSAPI names the principal of a cache with a ticket" : "a cache whose ticket expired is Expired, with no principal")
                    + " (got '" + answer + "', exit " + exit + ", " + errors + ")");
            }
        }
        finally { directory.Delete(true); }
    }

    /// <summary>Runs the check program with one argument and KRB5CCNAME set; with a directory, an empty KRB5_CONFIG there keeps
    /// the machine's own Kerberos configuration out.</summary>
    private static async Task<(int Exit, string Output, string Errors)> ChildAsync(string argument, string cache, string? directory = null)
    {
        var path = Environment.ProcessPath ?? throw new Exception("The check program's path is unknown");
        var start = new ProcessStartInfo(path) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        if (Path.GetFileNameWithoutExtension(path) == "dotnet") start.ArgumentList.Add(typeof(ConnectionFailureChecks).Assembly.Location);
        start.ArgumentList.Add(argument);
        start.Environment["KRB5CCNAME"] = cache;
        if (directory is not null)
        {
            var config = Path.Combine(directory, "krb5.conf");
            await File.WriteAllTextAsync(config, "");
            start.Environment["KRB5_CONFIG"] = config;
        }
        using var child = Process.Start(start) ?? throw new Exception("The Kerberos probe did not start");
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try { await child.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException) { child.Kill(true); throw new Exception("The Kerberos probe did not finish in 60 seconds"); }
        return (child.ExitCode, (await output).Trim(), (await errors).Trim());
    }

    /// <summary>A FILE credential cache in MIT's format version 4 (ccache_file_format) whose default principal is client@realm
    /// and which holds that client's ticket-granting ticket, ending at <paramref name="end"/>. The ticket's own bytes are
    /// filler: acquiring and inquiring a credential reads the cache's principal and the ticket's times, not the ticket.</summary>
    internal static byte[] CredentialCache(string client, string realm, DateTimeOffset end)
    {
        var buffer = new MemoryStream();
        void U16(int value) { buffer.WriteByte((byte)(value >> 8)); buffer.WriteByte((byte)value); }
        void U32(long value) { for (var shift = 24; shift >= 0; shift -= 8) buffer.WriteByte((byte)(value >> shift)); }
        void Data(byte[] value) { U32(value.Length); buffer.Write(value); }
        void Principal(int type, params string[] components)
        {
            U32(type);
            U32(components.Length);
            Data(System.Text.Encoding.UTF8.GetBytes(realm));
            foreach (var component in components) Data(System.Text.Encoding.UTF8.GetBytes(component));
        }
        U16(0x0504);
        U16(0); // No header fields (the KDC time offset is optional).
        Principal(1, client); // KRB5_NT_PRINCIPAL
        Principal(1, client);
        Principal(2, "krbtgt", realm); // KRB5_NT_SRV_INST
        U16(18); // aes256-cts-hmac-sha1-96
        Data(new byte[32]);
        var seconds = end.ToUnixTimeSeconds();
        U32(seconds - 36_000); // authtime
        U32(seconds - 36_000); // starttime
        U32(seconds); // endtime
        U32(0); // renew_till
        buffer.WriteByte(0); // is_skey
        U32(0x00400000); // ticket flags: initial
        U32(0); // addresses
        U32(0); // authdata
        Data([0x61, 0x03, 0x02, 0x01, 0x05]); // ticket
        Data([]); // second ticket
        return buffer.ToArray();
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

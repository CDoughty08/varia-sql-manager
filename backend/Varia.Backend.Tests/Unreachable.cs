namespace Varia.Backend.Tests;

// A server address that refuses at once, for the offline checks that need a failed open. Windows retries a refused TCP
// connection for about a second, which cost the offline run about 10 s there (75.6 s to 65.6 s); a missing named pipe fails
// immediately. Elsewhere a refused TCP connection already fails at once. The single backslash is deliberate: SqlClient
// refuses it as a malformed data source (SNI error 25) before any open, where a well-formed \\.\pipe name enters the Named
// Pipes provider and SqlClient's throttle of non-pooled opens, and under offline-stress.mjs's load timed out a third of the
// copies. The checks assert only that the failure is retryable, which both are.
static class Unreachable
{
    public static readonly string Source = OperatingSystem.IsWindows() ? @"np:\.\pipe\varia-checks-unreachable" : "tcp:127.0.0.1,1";
}

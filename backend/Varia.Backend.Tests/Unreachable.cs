namespace Varia.Backend.Tests;

// A server address that refuses at once, for the offline checks that need a failed open. Windows retries a refused TCP
// connection for about a second, which cost the offline run about 10 s there (75.6 s to 65.6 s); a missing named pipe fails
// immediately. Elsewhere a refused TCP connection already fails at once.
static class Unreachable
{
    public static readonly string Source = OperatingSystem.IsWindows() ? @"np:\.\pipe\varia-checks-unreachable" : "tcp:127.0.0.1,1";
}

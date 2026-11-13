namespace Varia.Backend.Entra;

/// <summary>SqlClient's provider has no request token parameter. ExecutionContext carries this request's budget into it,
/// including an abandoned OpenAsync, without changing concurrent manual connections.</summary>
internal sealed class EntraConnectScope : IDisposable
{
    internal static readonly TimeSpan BackgroundLimit = TimeSpan.FromSeconds(15);
    private static readonly AsyncLocal<CancellationToken> current = new();
    private static readonly AsyncLocal<string?> principal = new();
    private readonly CancellationToken previous;
    private readonly string? previousPrincipal;
    internal static CancellationToken Token => current.Value;
    internal static string? ExpectedPrincipal => principal.Value;

    internal EntraConnectScope(CancellationToken token, string? expectedPrincipal = null)
    {
        previous = current.Value;
        previousPrincipal = principal.Value;
        current.Value = token;
        principal.Value = expectedPrincipal;
    }

    public void Dispose() { current.Value = previous; principal.Value = previousPrincipal; }
}

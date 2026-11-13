namespace Varia.Backend.Entra;

/// <summary>SqlClient's provider has no request token parameter. An explicit scope authorizes token acquisition and
/// carries either the initial user authentication intent or an established target's principal plus request budget.
/// Pool maintenance that loses ExecutionContext is unauthorized and must not seed a private pool with another account.</summary>
internal sealed class EntraConnectScope : IDisposable
{
    internal static readonly TimeSpan BackgroundLimit = TimeSpan.FromSeconds(15);
    private sealed record State(CancellationToken Token, string? ExpectedPrincipal, bool AllowUnpinned);
    private static readonly AsyncLocal<State?> current = new();
    private readonly State? previous;
    internal static CancellationToken Token => current.Value?.Token ?? default;
    internal static string? ExpectedPrincipal => current.Value?.ExpectedPrincipal;
    internal static bool Authorized => current.Value is { ExpectedPrincipal: not null } or { AllowUnpinned: true };

    internal EntraConnectScope(CancellationToken token, string? expectedPrincipal = null, bool allowUnpinned = false)
    {
        previous = current.Value;
        current.Value = new(token, expectedPrincipal, allowUnpinned);
    }

    public void Dispose() => current.Value = previous;
}

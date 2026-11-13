namespace Varia.Backend.Entra;

/// <summary>SqlClient's provider has no request token parameter. ExecutionContext carries this request's budget into it,
/// including an abandoned OpenAsync, without changing concurrent manual connections.</summary>
internal sealed class EntraConnectScope : IDisposable
{
    internal static readonly TimeSpan BackgroundLimit = TimeSpan.FromSeconds(15);
    private static readonly AsyncLocal<CancellationToken> current = new();
    private readonly CancellationToken previous;
    internal static CancellationToken Token => current.Value;

    internal EntraConnectScope(CancellationToken token)
    {
        previous = current.Value;
        current.Value = token;
    }

    public void Dispose() => current.Value = previous;
}

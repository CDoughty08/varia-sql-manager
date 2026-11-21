using System.Collections.Concurrent;
using System.Net;
using Google;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The metadata calls' shared limiter (docs/bigquery.md, Object Explorer): Object Explorer's listers, Preview Rows, Properties and
/// Script As read BigQuery's REST API through it. Each principal has <see cref="PerPrincipal"/> calls in flight across every
/// handle it signs in, since BigQuery's per-user API rate limits count the principal, not the connection; a call waits for a
/// slot under its own deadline.
/// </summary>
internal sealed class BigQueryRateLimiter(int perPrincipal = BigQueryRateLimiter.PerPrincipal)
{
    public const int PerPrincipal = 16;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> slots = new(StringComparer.Ordinal);

    /// <summary>Waits for one of the principal's slots; disposing the result returns it.</summary>
    public async Task<IDisposable> EnterAsync(string principal, CancellationToken token)
    {
        var gate = slots.GetOrAdd(principal, _ => new SemaphoreSlim(perPrincipal, perPrincipal));
        await gate.WaitAsync(token);
        return new Slot(gate);
    }

    /// <summary>Slots in use for a principal (the checks read it).</summary>
    public int InUse(string principal) => slots.TryGetValue(principal, out var gate) ? perPrincipal - gate.CurrentCount : 0;

    sealed class Slot(SemaphoreSlim gate) : IDisposable
    {
        private int done;
        public void Dispose() { if (Interlocked.Exchange(ref done, 1) == 0) gate.Release(); }
    }

    /// <summary>BigQuery's rate limit refused the call (429, or 403 with reason rateLimitExceeded): retried after a backoff
    /// with jitter until the caller's deadline, since it did nothing.</summary>
    public static bool RateLimited(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
            if (current is GoogleApiException api)
                return api.HttpStatusCode == HttpStatusCode.TooManyRequests
                    || api.HttpStatusCode == HttpStatusCode.Forbidden && api.Error?.Errors?.Any(item => item.Reason == "rateLimitExceeded") == true;
        return false;
    }
}

internal sealed partial class BigQueryService
{
    /// <summary>Shared by every handle of this backend (one per principal).</summary>
    internal BigQueryRateLimiter Limiter { get; } = new();

    /// <summary>A free, idempotent metadata read under the principal's limiter: rate-limit refusals retry with jittered backoff until
    /// <paramref name="token"/> ends; other transient failures retry <see cref="ReadAttempts"/> times.</summary>
    internal async Task<T> MetadataAsync<T>(BigQueryConnection connection, Func<CancellationToken, Task<T>> call, CancellationToken token)
    {
        using var slot = await Limiter.EnterAsync(connection.Principal.PrincipalId, token);
        for (int attempt = 1, transient = 1; ; attempt++)
        {
            try { return await CallAsync(call, token); }
            catch (Exception error) when (!token.IsCancellationRequested && BigQueryRateLimiter.RateLimited(error))
            {
                var wait = Backoff(Math.Min(attempt, 5));
                await Task.Delay(wait + TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * wait.TotalMilliseconds / 2), token);
            }
            catch (Exception error) when (transient++ < ReadAttempts && Transient(error, token)) { await Task.Delay(Backoff(transient - 1), token); }
        }
    }
}

using System.Globalization;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// query.attach (docs/bigquery.md, Re-attaching to jobs): a BigQuery job keeps running whatever happens to Varia, so a tab
/// restored after a restart, a crash or a backend loss re-attaches to it by its id instead of cancelling it. The request runs
/// as query.execute does, without the insert: after the identity check (the connection's principal created the job) it
/// polls the job, lists a script's children again and reads the finished results by the usual residence rule. One attachment
/// per job: a second takes the first's over, and the first answers superseded.
/// </summary>
internal sealed partial class SqlService
{
    private Task<QueryResult> AttachBigQueryAsync(BigQueryAttachArgs args, RequestContext? context)
    {
        if (!Guid.TryParse(args.QueryId, out _) || !Guid.TryParse(args.SessionId, out _) || !BigQueryLimits.Uuid().IsMatch(args.JobKey ?? "")
            || !BigQueryJobLimits.IsJobId(args.JobId) || !BigQueryLimits.IsProject(args.Project) || !BigQueryJobLimits.IsLocation(args.Location)
            || args.MaxRows < 0 || args.MaxResultSets is < 1 or > 1000 || args.Transaction is not (null or "none" or "open" or "unknown"))
            throw new RequestException("INVALID_PARAMS", "The job reference, query, session or row limit is invalid.");
        var connection = bigQuery.Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        // Jobs belong to the billing project: another project's job is another connection's to re-attach.
        if (args.Project != connection.Options.Project)
            throw new RequestException("AUTH_IDENTITY", "This BigQuery job ran in project " + args.Project + ", not in this connection's project. Connect to " + args.Project + " to re-attach to it.");
        var query = new QueryArgs(args.ConnectionId, args.SessionId, null, "", args.QueryId, args.MaxRows, 0, MaxResultSets: args.MaxResultSets,
            DiscardResults: args.Detached, Prices: args.Prices, Residence: args.Residence, WindowCacheMiB: args.WindowCacheMiB, JobKey: args.JobKey);
        return ExecuteBigQueryAsync(query, connection, context, args);
    }

    /// <summary>"12 minutes ago": how long ago a re-attached job started, in Messages.</summary>
    internal static string Ago(TimeSpan elapsed)
    {
        if (elapsed < TimeSpan.FromMinutes(1)) return "less than a minute ago";
        if (elapsed < TimeSpan.FromHours(1)) return Unit((int)elapsed.TotalMinutes, "minute") + " ago";
        if (elapsed < TimeSpan.FromDays(1)) return Unit((int)elapsed.TotalHours, "hour") + " ago";
        return Unit((int)elapsed.TotalDays, "day") + " ago";
        static string Unit(int count, string unit) => count.ToString(CultureInfo.InvariantCulture) + " " + unit + (count == 1 ? "" : "s");
    }
}

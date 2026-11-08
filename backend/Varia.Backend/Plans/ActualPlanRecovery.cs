using System.Collections.Concurrent;
using System.Data;
using System.Globalization;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Plans;

internal static class ActualPlanRecovery
{
    internal const string Notice = "Abandoned actual plan collectors could not all be checked or removed. Recovery will be retried on a later capture.";
    internal static string Name(Guid client, Guid target, Guid owner) => $"VariaActual_{client:N}_{target:N}_{owner:N}";
    /// <summary>A recovery candidate. A legacy one (a single-GUID name from an earlier build) cannot prove its observer
    /// is gone: the candidate query and the drop's recheck select it only when it is clearly abandoned.</summary>
    internal sealed record Candidate(int Id, string Name, string BatchXml, string PlanXml, string Batch, string Plan, bool Legacy = false);

    internal static bool Owns(Candidate candidate, out Guid target, out Guid owner)
    {
        target = owner = Guid.Empty;
        var name = candidate.Name;
        if (name.Length != 110 || !name.StartsWith("VariaActual_", StringComparison.Ordinal) || name[44] != '_' || name[77] != '_'
            || !Guid.TryParseExact(name.AsSpan(12, 32), "N", out var client) || !Guid.TryParseExact(name.AsSpan(45, 32), "N", out target)
            || !Guid.TryParseExact(name.AsSpan(78, 32), "N", out owner)
            || client == Guid.Empty || target == Guid.Empty || owner == Guid.Empty || name != Name(client, target, owner)) return false;
        return Predicates(candidate, out _, out var watched) && watched == client;
    }

    /// <summary>A single-GUID collector from an earlier build: the name every such build used and Varia's predicates
    /// (each build filtered on the query connection's session id and client connection id), with that session id. The
    /// name's GUID was random or the connection's DMV id, so unlike <see cref="Owns"/> it is not tied to the predicate.</summary>
    internal static bool OwnsLegacy(Candidate candidate, out int spid)
    {
        spid = 0;
        var name = candidate.Name;
        return name.Length == 44 && name.StartsWith("VariaActual_", StringComparison.Ordinal) && name[12..].All(char.IsAsciiHexDigit)
            && Predicates(candidate, out spid, out _);
    }

    // Exactly the predicates every build's collector DDL writes: session_id and client_connection_id on the batch event,
    // and those plus is_system=false on the plan event. Anything modified or foreign proves nothing.
    private static bool Predicates(Candidate candidate, out int spid, out Guid client)
    {
        spid = 0;
        client = Guid.Empty;
        try
        {
            var batch = XElement.Parse(candidate.BatchXml);
            var values = batch.Elements("leaf").Select(leaf => leaf.Element("value")?.Value).ToList();
            if (values.Count != 2 || !int.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out spid) || spid is < 1 or > 32767
                || !Guid.TryParseExact(values[1], "D", out client) || client == Guid.Empty) return false;
            XElement Leaf(string comparison, string global, string value) => new("leaf",
                new XElement("comparator", new XAttribute("name", comparison), new XAttribute("package", "package0")),
                new XElement("global", new XAttribute("name", global), new XAttribute("package", "sqlserver")), new XElement("value", value));
            var expected = new XElement("and", Leaf("equal_uint64", "session_id", spid.ToString(CultureInfo.InvariantCulture)),
                Leaf("equal_guid", "client_connection_id", client.ToString("D").ToUpperInvariant()));
            var plan = XElement.Parse(candidate.PlanXml);
            // SQL Server serializes empty comparator/global nodes with explicit closing tags. LINQ to XML's
            // DeepEquals distinguishes those from self-closing nodes; normalize that irrelevant spelling only.
            foreach (var element in batch.Descendants().Concat(plan.Descendants()).Where(e => !e.HasElements && e.Value.Length == 0))
                element.RemoveNodes();
            return XNode.DeepEquals(batch, expected) && XNode.DeepEquals(plan,
                new XElement("and", expected, Leaf("equal_boolean", "is_system", "false")));
        }
        catch (XmlException) { return false; }
    }

    // Where each server's next scan starts (keyed by data source and test scope), so definitions that are refused, fail
    // to drop or block until the slice ends cannot keep later ones from every capture. Losing it only restarts the scan.
    private static readonly ConcurrentDictionary<string, int> resume = new(StringComparer.Ordinal);
    private const int ResumeEntries = 256;

    private static void Remember(string key, int after)
    {
        if (resume.Count >= ResumeEntries && !resume.ContainsKey(key)) resume.Clear();
        resume[key] = after;
    }

    /// <summary>The first <see cref="ActualPlanSql.RecoveryLimit"/> of a rotated selection, and where the next scan
    /// starts: after the last one examined while more remain, otherwise from the beginning.</summary>
    internal static (Candidate[] Examine, int Next) Window(IReadOnlyList<Candidate> selected)
    {
        var examine = selected.Take(ActualPlanSql.RecoveryLimit).ToArray();
        return (examine, selected.Count > examine.Length ? examine[^1].Id : 0);
    }

    // This is a slice of the existing five-second setup budget, never an extra setup deadline.
    internal static async Task<string?> RecoverAsync(SqlConnection observer, CancellationToken token, string? only = null)
    {
        using var recovery = CancellationTokenSource.CreateLinkedTokenSource(token);
        recovery.CancelAfter(TimeSpan.FromSeconds(1));
        try
        {
            return await ScanAsync(observer.DataSource + "\n" + only,
                after => SelectAsync(observer, only, after, recovery.Token),
                (candidate, target, owner) => DropAsync(observer, candidate, target, owner, recovery.Token));
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException)
        {
            token.ThrowIfCancellationRequested();
            return Notice;
        }
    }

    /// <summary>One bounded pass from the server's resume point. <paramref name="drop"/> answers false when the server
    /// refused that one drop; the pass goes on to the next definition and reports the notice.</summary>
    internal static async Task<string?> ScanAsync(string key, Func<int, Task<List<Candidate>>> select, Func<Candidate, Guid, Guid, Task<bool>> drop)
    {
        var (examine, next) = Window(await select(resume.TryGetValue(key, out var after) ? after : 0));
        var failed = false;
        foreach (var candidate in examine)
        {
            // Move past each definition before touching it, so one that hangs until the slice ends is not first again.
            Remember(key, candidate.Id);
            Guid target = Guid.Empty, owner = Guid.Empty;
            if (candidate.Legacy ? !OwnsLegacy(candidate, out _) : !Owns(candidate, out target, out owner)) continue;
            if (!await drop(candidate, target, owner)) failed = true;
        }
        Remember(key, next);
        return failed || next != 0 ? Notice : null;
    }

    private static async Task<List<Candidate>> SelectAsync(SqlConnection observer, string? only, int after, CancellationToken token)
    {
        var candidates = new List<Candidate>();
        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = ActualPlanSql.Candidates;
        command.Parameters.Add("@only", SqlDbType.NVarChar, 128).Value = (object?)only ?? DBNull.Value;
        command.Parameters.Add("@after", SqlDbType.Int).Value = after;
        await using var reader = await command.ExecuteReaderAsync(token);
        string Text(int ordinal) => reader.IsDBNull(ordinal) ? "" : reader.GetString(ordinal);
        // A missing predicate never proves ownership, but the row keeps its place in the rotation.
        while (await reader.ReadAsync(token))
            candidates.Add(new(reader.GetInt32(0), reader.GetString(1), Text(2), Text(3), Text(4), Text(5), reader.GetBoolean(6)));
        return candidates;
    }

    private static async Task<bool> DropAsync(SqlConnection observer, Candidate candidate, Guid target, Guid owner, CancellationToken token)
    {
        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.Parameters.Add("@id", SqlDbType.Int).Value = candidate.Id;
        command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = candidate.Name;
        command.Parameters.Add("@batch", SqlDbType.NVarChar, 3000).Value = candidate.Batch;
        command.Parameters.Add("@plan", SqlDbType.NVarChar, 3000).Value = candidate.Plan;
        if (candidate.Legacy)
        {
            if (!OwnsLegacy(candidate, out var spid)) return true;
            command.CommandText = ActualPlanSql.DropLegacy;
            command.Parameters.Add("@spid", SqlDbType.Int).Value = spid;
        }
        else
        {
            command.CommandText = ActualPlanSql.DropAbandoned;
            command.Parameters.Add("@target", SqlDbType.UniqueIdentifier).Value = target;
            command.Parameters.Add("@owner", SqlDbType.UniqueIdentifier).Value = owner;
        }
        try
        {
            await command.ExecuteNonQueryAsync(token);
            return true;
        }
        // One definition the server will not drop (a lock timeout, a concurrent change) must not end the pass. A lost
        // connection or the end of the slice still does.
        catch (SqlException) when (!token.IsCancellationRequested && observer.State == ConnectionState.Open) { return false; }
    }
}

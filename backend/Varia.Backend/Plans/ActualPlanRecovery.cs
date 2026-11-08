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
    internal sealed record Candidate(int Id, string Name, string BatchXml, string PlanXml, string Batch, string Plan);

    internal static bool Owns(Candidate candidate, out Guid target, out Guid owner)
    {
        target = owner = Guid.Empty;
        var name = candidate.Name;
        if (name.Length != 110 || !name.StartsWith("VariaActual_", StringComparison.Ordinal) || name[44] != '_' || name[77] != '_'
            || !Guid.TryParseExact(name.AsSpan(12, 32), "N", out var client) || !Guid.TryParseExact(name.AsSpan(45, 32), "N", out target)
            || !Guid.TryParseExact(name.AsSpan(78, 32), "N", out owner)
            || client == Guid.Empty || target == Guid.Empty || owner == Guid.Empty || name != Name(client, target, owner)) return false;
        try
        {
            var batch = XElement.Parse(candidate.BatchXml);
            if (!int.TryParse(batch.Element("leaf")?.Element("value")?.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var spid)
                || spid is < 1 or > 32767) return false;
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

    // This is a slice of the existing five-second setup budget, never an extra setup deadline.
    internal static async Task<string?> RecoverAsync(SqlConnection observer, CancellationToken token, string? onlyName = null)
    {
        using var recovery = CancellationTokenSource.CreateLinkedTokenSource(token);
        recovery.CancelAfter(TimeSpan.FromSeconds(1));
        try
        {
            var candidates = new List<Candidate>();
            await using (var command = observer.CreateCommand())
            {
                command.CommandTimeout = 0;
                command.CommandText = ActualPlanSql.Candidates;
                command.Parameters.Add("@onlyName", SqlDbType.NVarChar, 128).Value = (object?)onlyName ?? DBNull.Value;
                await using var reader = await command.ExecuteReaderAsync(recovery.Token);
                while (await reader.ReadAsync(recovery.Token))
                    if (!reader.IsDBNull(2) && !reader.IsDBNull(3) && !reader.IsDBNull(4) && !reader.IsDBNull(5))
                        candidates.Add(new(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5)));
            }
            foreach (var candidate in candidates.Take(ActualPlanSql.RecoveryLimit))
            {
                if (!Owns(candidate, out var target, out var owner)) continue;
                await using var command = observer.CreateCommand();
                command.CommandTimeout = 0;
                command.CommandText = ActualPlanSql.DropAbandoned;
                command.Parameters.Add("@id", SqlDbType.Int).Value = candidate.Id;
                command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = candidate.Name;
                command.Parameters.Add("@batch", SqlDbType.NVarChar, 3000).Value = candidate.Batch;
                command.Parameters.Add("@plan", SqlDbType.NVarChar, 3000).Value = candidate.Plan;
                command.Parameters.Add("@target", SqlDbType.UniqueIdentifier).Value = target;
                command.Parameters.Add("@owner", SqlDbType.UniqueIdentifier).Value = owner;
                await command.ExecuteNonQueryAsync(recovery.Token);
            }
            return candidates.Count > ActualPlanSql.RecoveryLimit ? Notice : null;
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException)
        {
            token.ThrowIfCancellationRequested();
            return Notice;
        }
    }
}

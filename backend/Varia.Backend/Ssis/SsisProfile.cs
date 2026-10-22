using System.Data;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Ssis;

/// <summary>What the catalog has (D-ssis 4.1), found through sys.objects and sys.columns in its database: customized logging
/// levels, Scale Out, event message GUIDs, executions' executed_count, the operation log size function and the schema version
/// check. They are probed, not inferred from the band, because an SSISDB restored from an older version can lag.</summary>
internal readonly record struct SsisFeatures(bool CustomizedLoggingLevels, bool ScaleOut, bool EventMessageGuid, bool ExecutedCount, bool OperationLogSize, bool CheckSchemaVersion)
{
    public static readonly string[] Names = ["customizedLoggingLevels", "scaleOut", "eventMessageGuid", "executedCount", "operationLogSize", "checkSchemaVersion"];

    public bool[] Flags => [CustomizedLoggingLevels, ScaleOut, EventMessageGuid, ExecutedCount, OperationLogSize, CheckSchemaVersion];

    public static SsisFeatures From(IReadOnlyList<bool> flags) => new(flags[0], flags[1], flags[2], flags[3], flags[4], flags[5]);

    /// <summary>Every combination, for the lint.</summary>
    public static IEnumerable<SsisFeatures> Every() => Enumerable.Range(0, 1 << Names.Length).Select(bits => From([.. Enumerable.Range(0, Names.Length).Select(bit => (bits >> bit & 1) == 1)]));

    public override string ToString()
    {
        var flags = Flags;
        return string.Join("+", Names.Where((_, index) => flags[index]).DefaultIfEmpty("none"));
    }
}

/// <summary>The caller's roles in the catalog. ssis_admin and ssis_logreader are read only for logins that are not sysadmin,
/// who may do everything those roles allow.</summary>
internal readonly record struct SsisRoles(bool Sysadmin, bool SsisAdmin, bool SsisLogreader)
{
    /// <summary>Reads catalog_properties and every object (ssis_admin or sysadmin).</summary>
    public bool Admin => Sysadmin || SsisAdmin;
}

/// <summary>A connection's view of the SSIS Catalog (D-ssis 4.1), read once per connection on the SSIS read pool by the
/// first SSIS request and cached until disconnect or until the catalog goes missing. CatalogDatabase is "SSISDB", or the
/// checks' fake catalog (SsisOptions); it is never a request field.</summary>
internal sealed record SsisProfile(string CatalogDatabase, bool Rcsi, SsisFeatures Features, SsisRoles Roles, string Auth, string HostPlatform, int Band, bool Cloud)
{
    /// <summary>Runs <see cref="SsisSql.Profile"/> on an open connection in the catalog's database. SQL errors propagate: a
    /// lock timeout on the role checks becomes BLOCKED like any read.</summary>
    public static async Task<SsisProfile> ProbeAsync(SqlConnection connection, string catalogDatabase, string auth, bool linux, int band, bool cloud, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = SsisSql.ProfilePrologue + SsisSql.Profile;
        command.CommandTimeout = 0;
        command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = catalogDatabase });
        await using var reader = await command.ExecuteReaderAsync(token);
        var rcsi = await reader.ReadAsync(token) && reader.GetBoolean(0);
        await reader.NextResultAsync(token);
        var features = new bool[SsisFeatures.Names.Length];
        if (await reader.ReadAsync(token)) for (var i = 0; i < features.Length; i++) features[i] = reader.GetBoolean(i);
        await reader.NextResultAsync(token);
        var roles = await reader.ReadAsync(token) ? new SsisRoles(reader.GetBoolean(0), reader.GetBoolean(1), reader.GetBoolean(2)) : default;
        // Drains the batch, so an error after the last result set (none is expected) still surfaces here.
        while (await reader.NextResultAsync(token)) { }
        return new(catalogDatabase, rcsi, SsisFeatures.From(features), roles, auth, linux ? "Linux" : "Windows", band, cloud);
    }

    public SsisProfileDto View() => new(Band, Cloud, HostPlatform, Auth, Rcsi,
        SsisFeatures.Names.Select((name, index) => (name, Features.Flags[index])).ToDictionary(item => item.name, item => item.Item2, StringComparer.Ordinal),
        new SsisRolesDto(Roles.Sysadmin, Roles.Admin, Roles.SsisAdmin, Roles.SsisLogreader));
}

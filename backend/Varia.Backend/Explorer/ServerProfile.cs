using System.Globalization;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Explorer;

/// <summary>What Object Explorer needs to know about a server, probed once at connect: the only place explorer code uses
/// metadata functions. Hadr and ViewServerState are kept for availability-group sublabels (a follow-up). CatalogBand is
/// the highest version band whose catalog columns exist, which raises the band because Azure SQL Database and Managed
/// Instance report ProductMajorVersion 12 while running the newest engine. ServerName (machineinstance) identifies the
/// server whatever name, address, login or database a connection used, for the live views' per-server cap.</summary>
internal sealed record ServerProfile(int Major, string? ProductVersion, int EngineEdition, string? Login, bool Hadr, bool ViewServerState, bool VectorDimensions,
    int CatalogBand = ExplorerCatalog.MinBand, string? ServerName = null)
{
    public const string ProbeSql = "SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), CONVERT(nvarchar(32), SERVERPROPERTY('ProductVersion')),"
        + " CONVERT(int, SERVERPROPERTY('EngineEdition')), SUSER_SNAME(), CONVERT(int, ISNULL(SERVERPROPERTY('IsHadrEnabled'), 0)),"
        + " ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE'), 0), CONVERT(bit, CASE WHEN COL_LENGTH('sys.all_columns', 'vector_dimensions') IS NULL THEN 0 ELSE 1 END),"
        + " CASE WHEN COL_LENGTH('sys.tables', 'ledger_type') IS NOT NULL THEN 16 WHEN OBJECT_ID('sys.edge_constraints') IS NOT NULL THEN 15"
        + " WHEN COL_LENGTH('sys.tables', 'is_node') IS NOT NULL THEN 14 WHEN COL_LENGTH('sys.tables', 'temporal_type') IS NOT NULL THEN 13 ELSE 12 END,"
        + " CONVERT(nvarchar(128), SERVERPROPERTY('ServerName'));";

    public ExplorerProfile Explorer(ExplorerCatalog catalog) => catalog.Profile(Major, EngineEdition, CatalogBand);

    /// <summary>Runs the probe on an open connection; a failure (permissions, an unusual edition) falls back to the
    /// version the provider reported, a box edition, and every flag off.</summary>
    public static async Task<ServerProfile> ProbeAsync(SqlConnection connection, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ProbeSql;
            command.CommandTimeout = 15;
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token) && !reader.IsDBNull(0))
                return new(reader.GetInt32(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.IsDBNull(2) ? 3 : reader.GetInt32(2), reader.IsDBNull(3) ? null : reader.GetString(3),
                    !reader.IsDBNull(4) && reader.GetInt32(4) == 1, !reader.IsDBNull(5) && Convert.ToInt32(reader.GetValue(5), CultureInfo.InvariantCulture) == 1, !reader.IsDBNull(6) && reader.GetBoolean(6),
                    reader.IsDBNull(7) ? ExplorerCatalog.MinBand : reader.GetInt32(7), reader.IsDBNull(8) ? null : reader.GetString(8));
        }
        catch (SqlException) { }
        catch (InvalidCastException) { }
        token.ThrowIfCancellationRequested();
        return Fallback(connection.ServerVersion);
    }

    /// <summary>The major version from the provider's "16.00.4135" form.</summary>
    public static ServerProfile Fallback(string? serverVersion) =>
        new(int.TryParse(serverVersion?.Split('.')[0], NumberStyles.None, CultureInfo.InvariantCulture, out var major) ? major : 0, null, 3, null, false, false, false);
}

using Microsoft.SqlServer.Management.Sdk.Sfc;

namespace Varia.Backend.Scripting;

/// <summary>The SMO URN of one object (spec B4). It starts from the Server object's own URN, so a server reached as
/// "host,port" and named differently by @@SERVERNAME still resolves, and every value goes through Urn.EscapeString.</summary>
internal static class UrnBuilder
{
    private static readonly string[] ServerTypes = ["Login", "Role", "Credential", "LinkedServer", "BackupDevice", "DdlTrigger", "Audit", "ServerAuditSpecification"];

    private static string Value(string text) => "'" + Urn.EscapeString(text) + "'";

    /// <param name="serverUrn">Server.Urn.Value, such as Server[@Name='HOST'].</param>
    /// <param name="urnType">The row's URN type from the catalogue (Column/Default is a default constraint).</param>
    /// <param name="parentUrnType">Table or View, for child kinds.</param>
    /// <param name="column">The column a default constraint belongs to (from the preflight).</param>
    public static string Build(string serverUrn, string kind, string urnType, ObjectRefDto target, string? parentUrnType = null, string? column = null)
    {
        if (kind == "database") return serverUrn + "/Database[@Name=" + Value(target.Name!) + "]";
        // Server-level kinds have no database; the same URN types below a database (Role, DdlTrigger) are database-level.
        if (target.Database is null)
        {
            if (!ServerTypes.Contains(urnType)) throw new InvalidOperationException("Not a server-level URN type: " + urnType);
            return serverUrn + "/" + urnType + "[@Name=" + Value(target.Name!) + "]";
        }
        var database = serverUrn + "/Database[@Name=" + Value(target.Database) + "]";
        if (target.Parent is { } parent)
        {
            var owner = database + "/" + (parentUrnType ?? throw new InvalidOperationException("A child needs its parent's URN type.")) + "[@Name=" + Value(parent.Name)
                + " and @Schema=" + Value(parent.Schema) + "]";
            if (urnType == "Column/Default") return owner + "/Column[@Name=" + Value(column ?? throw new InvalidOperationException("A default constraint needs its column.")) + "]/Default[@Name=" + Value(target.Name!) + "]";
            return owner + "/" + urnType + "[@Name=" + Value(target.Name!) + "]";
        }
        if (target.Schema is { } schema) return database + "/" + urnType + "[@Name=" + Value(target.Name!) + " and @Schema=" + Value(schema) + "]";
        return database + "/" + urnType + "[@Name=" + Value(target.Name!) + "]";
    }
}

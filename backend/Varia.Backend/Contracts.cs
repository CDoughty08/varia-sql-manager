namespace Varia.Backend;

internal sealed record ConnectOptions(string Server, string Database, string Authentication, string? Username, string? Password, bool TrustServerCertificate,
    string Encrypt = "mandatory", string? HostNameInCertificate = null, string? DisplayName = null, string? Color = null, AdvancedConnectionOptions? Advanced = null);
internal sealed record AdvancedConnectionOptions(
    int CommandTimeout = 0, int ConnectTimeout = 15, bool ColumnEncryption = false, bool SecureEnclaves = false,
    string AttestationProtocol = "None", string EnclaveAttestationUrl = "", bool MultipleActiveResultSets = false,
    string NetworkProtocol = "default", int PacketSize = 8000, string TransactionBinding = "Implicit Unbind", string TypeSystemVersion = "Latest",
    int ConnectRetryCount = 1, int ConnectRetryInterval = 10, string ApplicationName = "Varia SQL Manager", string WorkstationId = "",
    string ApplicationIntent = "ReadWrite", string CurrentLanguage = "", bool Replication = false, string IpAddressPreference = "IPv4First",
    string ServerCertificate = "", string AttachDbFilename = "", string FailoverPartner = "", string FailoverPartnerSpn = "",
    bool MultiSubnetFailover = false, string ServerSpn = "", bool UserInstance = false);
internal sealed record ConnectionInfo(string Id, string Server, string Database, string ServerVersion, string? DisplayName = null, string? Color = null, int CommandTimeout = 0);
internal sealed record DiscoveryArgs(string Scope);
internal sealed record DiscoveredServer(string Server, string Version, string Source);
internal sealed record DiscoveryResult(List<DiscoveredServer> Servers, string? Warning = null);
internal sealed record ConnectionArgs(string ConnectionId);
internal sealed record ServerObjectArgs(string ConnectionId, string Kind);
internal sealed record DatabaseArgs(string ConnectionId, string Database);
internal sealed record TableArgs(string ConnectionId, string Database, string Schema, string Name);
internal sealed record QueryArgs(string ConnectionId, string SessionId, string Database, string Sql, string QueryId, int MaxRows, int TimeoutSeconds, int StartLine = 1);
internal sealed record SessionArgs(string SessionId);
internal sealed record CancelArgs(string QueryId);
internal sealed record DatabaseInfo(string Name, bool IsSystem, bool IsSnapshot);
internal sealed record ServerObjectInfo(string Name, string Description);
internal sealed record TableInfo(string Schema, string Name);
internal sealed record ColumnInfo(string Name, string DataType);
internal sealed class ResultSet(List<ColumnInfo> columns, int batchNumber, int iteration, bool isPlan)
{
    public List<ColumnInfo> Columns { get; } = columns;
    public List<object?[]> Rows { get; } = [];
    public bool Truncated { get; set; }
    public bool Incomplete { get; set; }
    public int BatchNumber { get; } = batchNumber;
    public int Iteration { get; } = iteration;
    public string Kind { get; } = isPlan ? "executionPlan" : "rows";
}
internal sealed record QueryFailure(string Code, string Message, int BatchNumber, int Iteration);
internal sealed record QueryResult(List<ResultSet> ResultSets, List<string> Messages, long RecordsAffected, long ElapsedMs,
    string Status, QueryFailure? Error, int CompletedBatches, int TotalBatches, string Database, bool MessagesTruncated);

internal sealed class RequestException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace Varia.Backend.Tests;

static partial class BigQueryExecutionChecks
{
    /// <summary>The Google members the backend's compiled code references, as "Namespace.Type.Member" (nested types joined
    /// with '+'): what any spelling of a call compiles to, so a check on these holds however the source writes it.</summary>
    internal static HashSet<string> GoogleReferences()
    {
        using var stream = File.OpenRead(typeof(SqlService).Assembly.Location);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();
        string TypeName(EntityHandle handle) => handle.Kind switch
        {
            HandleKind.TypeReference => reader.GetTypeReference((TypeReferenceHandle)handle) is var type
                ? (type.ResolutionScope.Kind == HandleKind.TypeReference ? TypeName((EntityHandle)type.ResolutionScope) + "+" : reader.GetString(type.Namespace) + ".") + reader.GetString(type.Name)
                : "",
            HandleKind.TypeSpecification => "",
            _ => "",
        };
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var handle in reader.MemberReferences)
        {
            var member = reader.GetMemberReference(handle);
            var parent = TypeName(member.Parent);
            if (parent.StartsWith("Google.", StringComparison.Ordinal)) names.Add(parent + "." + reader.GetString(member.Name));
        }
        return names;
    }

    /// <summary>A query's rows are read only through its job's results page and tabledata.list (docs/ipc.md, Remote results):
    /// nothing in the backend compiles a call to jobs.query or to the high-level client's row readers, however it is spelled
    /// (a held resource, a property pattern, a target-typed request). tests/working-memory-lint.test.ts pins the callers of
    /// the two that are used.</summary>
    static void References(Action<bool, string> check)
    {
        var references = GoogleReferences();
        string[] banned =
        [
            "Google.Apis.Bigquery.v2.JobsResource.Query",
            "Google.Apis.Bigquery.v2.JobsResource+QueryRequest..ctor",
            "Google.Cloud.BigQuery.V2.BigQueryClient.ExecuteQuery",
            "Google.Cloud.BigQuery.V2.BigQueryClient.ExecuteQueryAsync",
            "Google.Cloud.BigQuery.V2.BigQueryClient.GetQueryResults",
            "Google.Cloud.BigQuery.V2.BigQueryClient.GetQueryResultsAsync",
            "Google.Cloud.BigQuery.V2.BigQueryClient.ListRows",
            "Google.Cloud.BigQuery.V2.BigQueryClient.ListRowsAsync",
        ];
        var found = banned.Where(references.Contains).ToList();
        check(found.Count == 0, "no compiled code reads a query's rows through jobs.query or the high-level client: " + string.Join(", ", found));
        // The two row reads that are used are referenced, so the scan sees Google's members at all.
        check(references.Contains("Google.Apis.Bigquery.v2.JobsResource.GetQueryResults") && references.Contains("Google.Apis.Bigquery.v2.TabledataResource.List"),
            "the reference scan sees the job results page and tabledata.list: " + string.Join(", ", references.Where(name => name.Contains("Bigquery.v2.", StringComparison.Ordinal)).Order().Take(20)));
    }
}

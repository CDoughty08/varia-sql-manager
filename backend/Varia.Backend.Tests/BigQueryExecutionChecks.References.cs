using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace Varia.Backend.Tests;

static partial class BigQueryExecutionChecks
{
    [System.Text.RegularExpressions.GeneratedRegex("^(?:ExecuteQuery|GetQueryResults|ListRows|ReadPage|GetRows)(?:Async)?$")]
    private static partial System.Text.RegularExpressions.Regex ReaderName();

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
        // The REST resource's jobs.query, and every row reader of the high-level client, on whichever of its types it sits
        // (BigQueryClient, BigQueryTable, BigQueryJob, BigQueryResults), and anything at all on BigQueryResults.
        var found = references.Where(name => name is "Google.Apis.Bigquery.v2.JobsResource.Query" or "Google.Apis.Bigquery.v2.JobsResource+QueryRequest..ctor"
            || name.StartsWith("Google.Cloud.BigQuery.V2.BigQueryResults.", StringComparison.Ordinal)
            || name.StartsWith("Google.Cloud.BigQuery.V2.", StringComparison.Ordinal) && ReaderName().IsMatch(name[(name.LastIndexOf('.') + 1)..])).Order().ToList();
        check(found.Count == 0, "no compiled code reads a query's rows through jobs.query or the high-level client: " + string.Join(", ", found));
        check(ReaderName().IsMatch("ListRowsAsync") && ReaderName().IsMatch("ReadPage") && ReaderName().IsMatch("GetRowsAsync") && ReaderName().IsMatch("ExecuteQuery")
            && ReaderName().IsMatch("GetQueryResultsAsync") && !ReaderName().IsMatch("CreateQueryJob") && !ReaderName().IsMatch("GetTable"),
            "the reader names cover each row reader's sync and async forms and nothing else");
        // The two row reads that are used are referenced, so the scan sees Google's members at all.
        check(references.Contains("Google.Apis.Bigquery.v2.JobsResource.GetQueryResults") && references.Contains("Google.Apis.Bigquery.v2.TabledataResource.List"),
            "the reference scan sees the job results page and tabledata.list: " + string.Join(", ", references.Where(name => name.Contains("Bigquery.v2.", StringComparison.Ordinal)).Order().Take(20)));
    }
}

namespace Varia.Backend.Search;

/// <summary>language.lookup's bounds (languageLookupLimits in src/shared/language-lookup.ts).</summary>
internal static class EditorLookupLimits
{
    public const int Requests = 16, Segments = 3, SegmentChars = 1024, PrefixChars = 4608, Items = 2000, DefaultItems = 500, TotalItems = 4000;
}

internal static class EditorLookup
{
    private static RequestException Invalid(string what) => new("INVALID_PARAMS", "Invalid language lookup: " + what);

    public static void Validate(LanguageLookupArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (args.Requests is not { Count: > 0 and <= EditorLookupLimits.Requests }) throw Invalid("requests.");
        foreach (var request in args.Requests)
        {
            if (request is null) throw Invalid("requests.");
            if (request.Path is not { Count: <= EditorLookupLimits.Segments } || request.Path.Any(segment => segment is not { Length: > 0 and <= EditorLookupLimits.SegmentChars })) throw Invalid("path.");
            if (request.Prefix is { Length: > EditorLookupLimits.PrefixChars }) throw Invalid("prefix.");
            if (request.Exact == true && string.IsNullOrEmpty(request.Prefix)) throw Invalid("exact needs a prefix.");
            if (request.Limit is < 1 or > EditorLookupLimits.Items) throw Invalid("limit.");
        }
    }

    /// <summary>Answers every request from one snapshot of a BigQuery connection's index.</summary>
    public static LanguageLookupResult Answer(BigQueryLookup lookup, LanguageLookupArgs args)
    {
        Validate(args);
        var left = EditorLookupLimits.TotalItems;
        var answers = new List<LanguageLookupAnswer>(args.Requests.Count);
        foreach (var request in args.Requests) answers.Add(One(lookup, request, ref left));
        return new(lookup.Index, answers);
    }

    private static string State(LookupState state) => state switch
    {
        LookupState.Ready => "ready", LookupState.Partial => "partial", LookupState.Building => "building", LookupState.Skipped => "skipped", _ => "absent"
    };

    private static LanguageLookupAnswer One(BigQueryLookup lookup, LanguageLookupPath request, ref int left)
    {
        var path = request.Path;
        var prefix = request.Prefix ?? "";
        var exact = request.Exact == true;
        var limit = Math.Min(request.Limit ?? EditorLookupLimits.DefaultItems, left);
        bool Keeps(string name) => exact ? string.Equals(name, prefix, StringComparison.OrdinalIgnoreCase) : name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        // Names that tell case apart keep the one an exact request resolves to: the exact spelling, else the only one that differs in case.
        static IEnumerable<string> Resolved(IEnumerable<string> names, string name)
        {
            var close = names.Where(known => string.Equals(known, name, StringComparison.OrdinalIgnoreCase)).ToList();
            return close.Contains(name, StringComparer.Ordinal) ? [name] : close.Count == 1 ? close : [];
        }
        (List<LanguageLookupItem> Items, bool Truncated) Take(IEnumerable<LanguageLookupItem> items, ref int remaining)
        {
            var list = new List<LanguageLookupItem>();
            var truncated = false;
            foreach (var item in items)
            {
                if (list.Count >= limit) { truncated = true; break; }
                list.Add(item);
            }
            remaining -= list.Count;
            return (list, truncated);
        }
        switch (path.Count)
        {
            case 0:
            {
                var names = exact ? Resolved(lookup.Projects, prefix) : lookup.Projects.Where(Keeps);
                var (items, truncated) = Take(names.Select(name => new LanguageLookupItem(name, "bqProject", Detail: lookup.NamesOnly(name) ? "names" : null)), ref left);
                return new("ready", [], items, truncated);
            }
            case 1:
            {
                var project = lookup.Project(path[0]);
                if (project is null) return new("absent", [.. path], [], false);
                var datasets = lookup.Datasets(project);
                var names = exact ? Resolved(datasets, prefix) : datasets.Where(Keeps);
                var (items, truncated) = Take(names.Select(name => new LanguageLookupItem(name, "bqDataset")), ref left);
                return new(State(lookup.ProjectState(project)), [project], items, truncated);
            }
            case 2:
            {
                var dataset = lookup.Dataset(path[0], path[1]);
                var resolved = dataset.State == LookupState.Absent && lookup.Project(path[0]) is null ? [.. path] : new List<string> { dataset.Project, dataset.Dataset };
                IEnumerable<LookupObject> objects;
                if (exact) objects = lookup.Object(dataset, prefix) is { } one ? [one] : [];
                else objects = lookup.Objects(dataset).Where(entry => Keeps(entry.Name)).OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ThenBy(entry => entry.Name, StringComparer.Ordinal);
                var (items, truncated) = Take(objects.Select(entry => new LanguageLookupItem(entry.Name, entry.Kind, entry.Subtype, Detail: BigQueryLookup.Facts(entry)?.Signature,
                    Shards: BigQueryLookup.Shards(entry))), ref left);
                return new(State(dataset.State), resolved, items, truncated, Skip: dataset.Skip?.Code);
            }
            default:
            {
                var dataset = lookup.Dataset(path[0], path[1]);
                var owner = lookup.Object(dataset, path[2]);
                if (owner is not { } entry)
                    return new(State(dataset.State), dataset.Held is null ? [.. path] : [dataset.Project, dataset.Dataset], [], false, Skip: dataset.Skip?.Code);
                var facts = BigQueryLookup.Facts(entry);
                // Columns the budget left out make the object's details incomplete, whatever its facts say.
                var shown = new LanguageLookupObject(entry.Name, entry.Kind, entry.Subtype, facts?.Detailed == true && dataset.Held?.ChildrenLeftOut != true, facts?.Rows, facts?.Bytes, facts?.Partitioning, facts?.Clustering,
                    facts?.Signature, BigQueryLookup.Shards(entry), facts?.ColumnsCut == true ? true : null, entry.Table.Modified(entry.At));
                var details = request.Details == true;
                var columns = lookup.Columns(entry).Where(column => Keeps(column.Name));
                var (items, truncated) = Take(columns.Select(column => new LanguageLookupItem(column.Name, "bqColumn", column.Entry.Subtype, column.Type?.TypeName,
                    column.Type is { } type ? (type.Flags & TypedFlags.Nullable) != 0 : null, Description: details ? BigQueryLookup.Description(column) : null)), ref left);
                return new(State(dataset.State), [dataset.Project, dataset.Dataset, entry.Name], items, truncated, shown, dataset.Skip?.Code);
            }
        }
    }
}

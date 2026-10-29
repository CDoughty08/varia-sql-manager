using System.Globalization;

namespace Varia.Backend.Explorer;

/// <summary>A validated explorer.children request: the node, its object (or the folder's owner), the folder, the query whose
/// rows the node lists (the folder's, or the object kind's own), and the database the request reads (absent for server-scope
/// nodes).</summary>
internal sealed record ExplorerRequest(string ConnectionId, string RequestId, NodeRefDto Node, ObjectRefDto Object, CatalogFolder? Folder, string? Database,
    string? Subtype, string? Cursor, int PageSize, ExplorerFilterDto? Filter, string? List = null);

/// <summary>Re-validates what main's zod schemas (src/shared/explorer/schema.ts) accept, against the embedded catalogue.
/// Every failure is INVALID_PARAMS; profile gates are checked once the connection is known (<see cref="CheckServed"/>).</summary>
internal static class ExplorerRefs
{
    public const int MaxIdentifier = 128;
    /// <summary>The longest name any kind may declare (an SSIS package's 260); every other kind keeps 128.</summary>
    public const int MaxName = 260;
    public const int MaxPageSize = 2000;
    private static readonly string[] TextOps = ["contains", "equals", "notContains"];
    private static readonly string[] DateOps = ["equals", "lessThan", "lessOrEqual", "greaterThan", "greaterOrEqual", "between", "notBetween"];

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid Object Explorer request: " + detail);

    /// <summary>An identifier as the server stores it: 1–128 UTF-16 code units, used verbatim, never U+0000.</summary>
    public static bool Ident(string? value) => Ident(value, MaxIdentifier);

    /// <summary>A name of at most <paramref name="max"/> UTF-16 code units, used verbatim, never U+0000.</summary>
    public static bool Ident(string? value, int max) => value is not null && value.Length >= 1 && value.Length <= max && !value.Contains('\0');

    public static ExplorerRequest Validate(ExplorerChildrenArgs args, ExplorerCatalog catalog)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var node = args.Node ?? throw Invalid("node.");
        ObjectRefDto target;
        CatalogFolder? folder = null;
        switch (node.Type)
        {
            case "object" when node.Object is { } item && node.Owner is null && node.Folder is null:
                Object(item, catalog);
                target = item;
                break;
            case "folder" when node.Owner is { } owner && node.Object is null && node.Folder is { } id:
                Object(owner, catalog);
                folder = catalog.Folder(id) ?? throw Invalid("folder.");
                if (!catalog.FolderOwnerKinds(id).Contains(owner.Kind)) throw Invalid("a " + owner.Kind + " has no " + id + " folder.");
                target = owner;
                break;
            default: throw Invalid("node.");
        }
        if (args.Subtype is { } subtype && (node.Type != "object" || !catalog.KindOf(target.Kind).Subtypes.Contains(subtype))) throw Invalid("subtype.");
        if (args.PageSize is < 1 or > MaxPageSize) throw Invalid("pageSize.");
        var list = folder is null ? catalog.KindOf(target.Kind).List : folder.List;
        if (args.Cursor is not null && (list is null || args.Cursor.Length > ExplorerCursor.MaxLength || !args.Cursor.StartsWith("v1." + list + ".", StringComparison.Ordinal)))
            throw Invalid("cursor.");
        if (args.Filter is { } filter) Filter(filter, folder);
        var database = target.Kind == "database" ? target.Name : target.Database;
        return new(args.ConnectionId, args.RequestId, node, target, folder, database, args.Subtype, args.Cursor, args.PageSize ?? MaxPageSize, args.Filter, list);
    }

    /// <summary>The ref's shape: the fields its kind's scope requires and forbids, identifiers (the name within the kind's
    /// bound), and a child's parent kind.</summary>
    public static void Object(ObjectRefDto value, ExplorerCatalog catalog)
    {
        var kind = value.Kind is { } name ? catalog.Kind(name) : null;
        if (kind is null) throw Invalid("kind.");
        var scope = catalog.Scopes[kind.Scope];
        bool Has(string field) => field switch
        {
            "database" => value.Database is not null,
            "schema" => value.Schema is not null,
            "name" => value.Name is not null,
            "parent" => value.Parent is not null,
            "ssisFolder" => value.SsisFolder is not null,
            "ssisProject" => value.SsisProject is not null,
            _ => throw new InvalidOperationException("Unknown ref field " + field)
        };
        if (scope.Required.Any(field => !Has(field)) || scope.Forbidden.Any(Has)) throw Invalid("the fields of a " + kind.Kind + ".");
        if (value.Database is not null && !Ident(value.Database) || value.Schema is not null && !Ident(value.Schema) || value.Name is not null && !Ident(value.Name, kind.MaxName)
            || value.SsisFolder is not null && !Ident(value.SsisFolder) || value.SsisProject is not null && !Ident(value.SsisProject))
            throw Invalid("a name.");
        if (value.Parent is { } parent && (!kind.Parents.Contains(parent.Kind ?? "") || !Ident(parent.Schema) || !Ident(parent.Name))) throw Invalid("parent.");
    }

    private static void Filter(ExplorerFilterDto filter, CatalogFolder? folder)
    {
        var allowed = folder?.List is null ? [] : folder.Filter;
        var present = new (string Property, object? Value)[] { ("name", filter.Name), ("schema", filter.Schema), ("owner", filter.Owner), ("created", filter.Created) }
            .Where(item => item.Value is not null).ToList();
        if (present.Count == 0 || present.Any(item => !allowed.Contains(item.Property))) throw Invalid("filter.");
        foreach (var text in new[] { filter.Name, filter.Schema, filter.Owner })
            if (text is not null && (!TextOps.Contains(text.Op) || text.Value is not { Length: >= 1 and <= MaxIdentifier })) throw Invalid("filter.");
        if (filter.Created is { } created)
        {
            var range = created.Op is "between" or "notBetween";
            if (!DateOps.Contains(created.Op) || Date(created.Value) is not { } first || range != (created.Value2 is not null)
                || created.Value2 is not null && (Date(created.Value2) is not { } second || second < first))
                throw Invalid("filter date.");
        }
    }

    /// <summary>A filter date: yyyy-MM-dd from 1753-01-01 (datetime's range, so it converts on any server) to 9999-12-31.</summary>
    public static DateTime? Date(string? value) =>
        value is { Length: 10 } && DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) && date.Year >= 1753 ? date : null;

    /// <summary>The folder (and every folder above it) is served on this server, and the object kind can be browsed there.</summary>
    public static void CheckServed(ExplorerRequest request, ExplorerCatalog catalog, ExplorerProfile profile)
    {
        if (request.Folder is { } folder && !catalog.Served(folder.Id, profile)) throw Invalid("this server has no " + folder.Id + " folder.");
    }
}

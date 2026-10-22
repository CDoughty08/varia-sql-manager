namespace Varia.Backend.Activity;

/// <summary>A column value filter, as src/shared/activity/schema.ts declares it.</summary>
internal sealed record ActivityColumnFilterDto(string Column, List<string>? Values = null, bool? Blanks = null, bool? NonBlanks = null);

/// <summary>The monitor's filter for one table (the live layer's `args.activity`): Processes' view chip and toggles, the
/// filter box and the column value filters.</summary>
internal sealed record ActivityFilterDto(string Table, string? View = null, bool? ShowSystem = null, bool? ShowVaria = null, string? Text = null, List<ActivityColumnFilterDto>? ColumnFilters = null);

/// <summary>What Processes' view chips and toggles test about a session, which the sessions probe works out per row.</summary>
internal readonly record struct SessionFacts(bool System = false, bool VariaPool = false, bool Active = false, bool Blocked = false, bool Blocking = false,
    bool IdleOpenTransaction = false, bool RollingBack = false);

/// <summary>The filter engine: one validated filter, applied to each row of a sample in memory, so the SQL never changes.
/// Columns, bounds and view ids come from the catalogue; a filter that breaks one is refused as INVALID_PARAMS, as zod
/// refuses it in main.</summary>
internal sealed class ActivityFilter
{
    private const int MaxColumnId = 64;
    private readonly string? view;
    private readonly bool showSystem;
    private readonly bool showVaria;
    private readonly string? text;
    private readonly IReadOnlyList<string> textColumns;
    private readonly IReadOnlyList<(string Column, HashSet<string> Values, bool Blanks, bool NonBlanks)> columns;

    private ActivityFilter(string table, string? view, bool showSystem, bool showVaria, string? text, IReadOnlyList<string> textColumns,
        IReadOnlyList<(string, HashSet<string>, bool, bool)> columns)
    {
        Table = table;
        this.view = view;
        this.showSystem = showSystem;
        this.showVaria = showVaria;
        this.text = text;
        this.textColumns = textColumns;
        this.columns = columns;
    }

    public string Table { get; }

    private static RequestException Invalid(string message) => new("INVALID_PARAMS", message);

    public static ActivityFilter Compile(ActivityCatalog catalog, ActivityFilterDto dto)
    {
        if (!catalog.Tables.TryGetValue(dto.Table, out var table)) throw Invalid("Unknown Activity Monitor table.");
        var sessions = dto.Table == "sessions";
        if (!sessions && (dto.View is not null || dto.ShowSystem is not null || dto.ShowVaria is not null)) throw Invalid("Only Processes takes a view or session toggles.");
        if (dto.View is not null && !catalog.Views.Contains(dto.View)) throw Invalid("Unknown Activity Monitor view.");
        if (dto.Text is { } search && search.Length > catalog.Limit("filterText")) throw Invalid("The filter text is too long.");
        var filters = dto.ColumnFilters ?? [];
        if (filters.Count > catalog.Limit("columnFilters")) throw Invalid("Too many column filters.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var compiled = new List<(string, HashSet<string>, bool, bool)>();
        foreach (var filter in filters)
        {
            if (filter.Column.Length is 0 or > MaxColumnId || !table.FacetColumns.Contains(filter.Column)) throw Invalid("The column has no value filter.");
            if (!seen.Add(filter.Column)) throw Invalid("One filter per column.");
            var values = filter.Values ?? [];
            if (values.Count > catalog.Limit("columnFilterValues") || values.Any(value => value.Length > catalog.Limit("columnFilterChars"))) throw Invalid("Too many or too long filter values.");
            if (values.Count == 0 && filter.Blanks != true && filter.NonBlanks != true) throw Invalid("A column filter needs a value, (Blanks) or (Non-blanks).");
            compiled.Add((filter.Column, values.ToHashSet(StringComparer.Ordinal), filter.Blanks == true, filter.NonBlanks == true));
        }
        var textColumns = table.Columns.Where(column => table.TextColumns.Contains(column.Id)).Select(column => column.Id).ToList();
        return new(dto.Table, sessions ? dto.View ?? "all" : null, dto.ShowSystem == true, dto.ShowVaria == true, string.IsNullOrEmpty(dto.Text) ? null : dto.Text, textColumns, compiled);
    }

    /// <summary>Whether a row passes. <paramref name="cell"/> gives a column's text as the grid shows it (null for NULL);
    /// <paramref name="facts"/> matter only for Processes.</summary>
    public bool Matches(Func<string, string?> cell, SessionFacts facts = default)
    {
        if (view is not null)
        {
            if (facts.System && !showSystem || facts.VariaPool && !showVaria) return false;
            var shown = view switch
            {
                "active" => facts.Active,
                "blocked" => facts.Blocked,
                "blocking" => facts.Blocking,
                "idleOpenTransaction" => facts.IdleOpenTransaction,
                "rollingBack" => facts.RollingBack,
                _ => true
            };
            if (!shown) return false;
        }
        if (text is not null && !textColumns.Any(column => cell(column)?.Contains(text, StringComparison.OrdinalIgnoreCase) == true)) return false;
        foreach (var (column, values, blanks, nonBlanks) in columns)
        {
            var value = cell(column);
            var blank = string.IsNullOrEmpty(value);
            if (!(blank ? blanks : nonBlanks || values.Contains(value!))) return false;
        }
        return true;
    }
}

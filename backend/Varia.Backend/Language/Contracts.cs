namespace Varia.Backend.Language;

// LSP positions are zero-based UTF-16 offsets. Engine-specific connection options and credentials never cross this API.
internal sealed record LanguagePosition(int Line, int Character);
internal sealed record LanguageRange(LanguagePosition Start, LanguagePosition End);
internal sealed record LanguageContext(string ProviderId, string? ConnectionId = null, string? Database = null,
    string? DefaultSchema = null, string? Project = null, string? Dataset = null);
internal sealed record LanguageRequest(string DocumentId, int Version, string Text, LanguageContext Context, LanguagePosition Position);
internal sealed record LanguageRefreshRequest(string DocumentId, int Version, string Text, LanguageContext Context);
internal sealed record LanguageRefreshResult(bool Refreshed);
internal sealed record LanguageCloseArgs(string DocumentId);
internal sealed record LanguageCloseResult(bool Closed);
internal sealed record LanguageTextEdit(LanguageRange Range, string NewText);
internal sealed record LanguageCompletionItem(string Label, int? Kind = null, string? Detail = null, string? Documentation = null,
    string? InsertText = null, int? InsertTextFormat = null, LanguageTextEdit? TextEdit = null, string? SortText = null, string? FilterText = null);
internal sealed record LanguageCompletionResult(IReadOnlyList<LanguageCompletionItem> Items, bool IsIncomplete);
internal sealed record LanguageHover(string Contents, LanguageRange? Range = null);
internal sealed record LanguageDiagnostic(LanguageRange Range, string Message, int Severity = 1, string? Code = null, string? Source = null);
internal sealed record LanguageDiagnosticResult(int Version, IReadOnlyList<LanguageDiagnostic> Items, bool IsIncomplete = false);
internal sealed record LanguageProviderStatus(string Id, bool Configured, bool Completion, bool Hover, string? Reason = null, bool Refresh = false, bool Diagnostics = false);
internal sealed record LanguageStatus(IReadOnlyList<LanguageProviderStatus> Providers);
internal sealed record LanguageStatusArgs;

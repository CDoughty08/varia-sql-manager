using System.Runtime.InteropServices;

namespace Varia.Backend.Language;

/// <summary>Default locations come only from Varia's installation/source tree. Main passes the precise location; the
/// fallback also supports running the backend directly. A developer's explicit path remains a trusted opt-in override.</summary>
internal sealed record SqlToolsRuntime(string ExecutablePath, bool IsOverride)
{
    // STS otherwise auto-generates a log in its working directory and writes unhandled exception details there.
    // Its listener opens lazily: the supported Off level prevents file creation as well as request/exception traces.
    internal IReadOnlyList<string> Arguments => ["--parent-pid", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture), "--tracing-level", "Off"];

    internal static SqlToolsRuntime Resolve(string? explicitPath = null)
    {
        var configured = explicitPath ?? Environment.GetEnvironmentVariable("VARIA_SQLTOOLS_SERVICE_PATH");
        if (!string.IsNullOrWhiteSpace(configured)) return new(configured,
            explicitPath is not null || Environment.GetEnvironmentVariable("VARIA_SQLTOOLS_SERVICE_SOURCE") != "bundled");
        return Bundled(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsMacOS() ? "osx" : "linux",
            RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant());
    }

    internal static SqlToolsRuntime Bundled(string backendDirectory, string platform, string architecture)
    {
        var executable = platform == "win" ? "MicrosoftSqlToolsServiceLayer.exe" : "MicrosoftSqlToolsServiceLayer";
        var installed = Path.GetFullPath(Path.Combine(backendDirectory, "..", "sqltools-service", executable));
        if (File.Exists(installed)) return new(installed, false);
        // backend/Varia.Backend/bin/{configuration}/net11.0: five parents reach the source checkout.
        var source = Path.GetFullPath(Path.Combine(backendDirectory, "..", "..", "..", "..", "..", "artifacts", "sqltools-service", platform + "-" + architecture, executable));
        return new(File.Exists(source) ? source : installed, false);
    }

    internal string? UnavailableReason() => !Path.IsPathFullyQualified(ExecutablePath) || !File.Exists(ExecutablePath)
        ? IsOverride
            ? "VARIA_SQLTOOLS_SERVICE_PATH must name an existing executable by its absolute path. Restart Varia after changing it."
            : "SQL Server IntelliSense files are missing. Reinstall Varia, or prepare the bundled language-service runtime when running from source."
        : null;
}

using System.ComponentModel;
using System.Diagnostics;

namespace Varia.Backend.Entra;

/// <summary>Opens MSAL's sign-in page in the system web browser, in place of MSAL's own launcher. The backend's standard
/// output carries protocol frames, and a process started without redirection inherits it: xdg-open, open, and the browser
/// they start can print there, which would corrupt the frames. So on Linux and macOS the tool runs with all three of its
/// streams on /dev/null (through /bin/sh, the page passed as an argument, never interpolated), and on Windows through the
/// shell, which shares no handles. Only an https page on an allowed sign-in host is opened.</summary>
internal static class EntraBrowser
{
    /// <summary>How long the tool may take to say that no browser opened the page; one that keeps running opened it.</summary>
    internal static readonly TimeSpan LaunchWait = TimeSpan.FromSeconds(5);

    internal static Task OpenAsync(Uri page) => OpenAsync(page, OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux");

    /// <summary>What starts the browser on <paramref name="platform"/> (windows, macos or linux).</summary>
    internal static ProcessStartInfo StartInfo(Uri page, string platform)
    {
        if (page.Scheme != Uri.UriSchemeHttps || !page.IsDefaultPort || page.UserInfo.Length > 0 || !Array.Exists(EntraEndpoints.AuthorityHosts, host => string.Equals(host, page.Host, StringComparison.OrdinalIgnoreCase)))
            throw new EntraBrowserException("The sign-in page is not at a Microsoft Entra sign-in address.");
        if (platform == "windows") return new ProcessStartInfo(page.AbsoluteUri) { UseShellExecute = true };
        var start = new ProcessStartInfo("/bin/sh") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "-c", "exec \"$0\" \"$1\" </dev/null >/dev/null 2>&1", platform == "macos" ? "open" : "xdg-open", page.AbsoluteUri }) start.ArgumentList.Add(argument);
        return start;
    }

    private static Task OpenAsync(Uri page, string platform) => RunAsync(StartInfo(page, platform));

    /// <summary>Starts the browser; resolves to what the launcher's own streams carried (nothing: the tool's go to /dev/null).</summary>
    internal static async Task<string> RunAsync(ProcessStartInfo start)
    {
        Process? process;
        try { process = Process.Start(start); }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or PlatformNotSupportedException) { throw new EntraBrowserException("The web browser could not be started."); }
        // The shell may hand the page to a browser that is already running and start no process.
        if (process is null || start.UseShellExecute) { process?.Dispose(); return ""; }
        using (process)
        {
            process.StandardInput.Close();
            var drained = Task.WhenAll(process.StandardOutput.ReadToEndAsync(), process.StandardError.ReadToEndAsync());
            using var wait = new CancellationTokenSource(LaunchWait);
            try { await process.WaitForExitAsync(wait.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { return ""; }
            var output = string.Concat(await drained.ConfigureAwait(false));
            // xdg-open answers 3 when no tool could open the page, and the shell 127 when xdg-open is missing.
            if (process.ExitCode != 0) throw new EntraBrowserException("No web browser opened the sign-in page.");
            return output;
        }
    }
}

/// <summary>The system web browser could not be opened for a sign-in.</summary>
internal sealed class EntraBrowserException(string message) : Exception(message);

using Microsoft.Data.Sql;
using Microsoft.Win32;

namespace Varia.Backend;

internal sealed class ServerDiscovery
{
    private readonly object gate = new();
    private Task<List<DiscoveredServer>>? network;
    internal async Task<DiscoveryResult> DiscoverAsync(DiscoveryArgs args)
    {
        if (args.Scope is not ("local" or "network")) throw new RequestException("INVALID_PARAMS", "Unsupported server discovery scope.");
        if (args.Scope == "local") return Local();
        Task<List<DiscoveredServer>> pending;
        lock (gate)
        {
            // A provider enumeration cannot be cancelled; coalesce concurrent/slow refreshes.
            if (network is null || network.IsCompleted) network = Task.Run(() =>
            {
                using var table = SqlDataSourceEnumerator.Instance.GetDataSources();
                return table.Rows.Cast<System.Data.DataRow>().Select(row => new DiscoveredServer(
                    Convert.ToString(row["ServerName"]) + (string.IsNullOrEmpty(Convert.ToString(row["InstanceName"])) ? "" : "\\" + Convert.ToString(row["InstanceName"])),
                    Convert.ToString(row["Version"]) ?? "", "network")).Where(item => !string.IsNullOrWhiteSpace(item.Server)).DistinctBy(item => item.Server, StringComparer.OrdinalIgnoreCase).OrderBy(item => item.Server).ToList();
            });
            pending = network;
        }
        try { return new(await pending.WaitAsync(TimeSpan.FromSeconds(25)), "Network discovery may be incomplete. SQL Server Browser and firewall settings determine which servers respond."); }
        catch (TimeoutException) { return new([], "Network discovery timed out. You can enter a server name directly or try Refresh again."); }
        catch (Exception) { return new([], "SQL Server network discovery is unavailable. You can enter a server name directly."); }
    }
    private static DiscoveryResult Local()
    {
        if (!OperatingSystem.IsWindows()) return new([], "Local SQL Server discovery is available on Windows. Enter a server name directly on this platform.");
        var servers = new List<DiscoveredServer>();
        try
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var instances = root.OpenSubKey(@"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL");
                foreach (var name in instances?.GetValueNames() ?? []) servers.Add(new(name == "MSSQLSERVER" ? "localhost" : "localhost\\" + name, "", "local"));
            }
            using var userInstances = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Microsoft SQL Server\UserInstances");
            foreach (var key in userInstances?.GetSubKeyNames() ?? [])
            {
                using var instance = userInstances!.OpenSubKey(key);
                if (instance?.GetValue("InstanceName") is string name && name.Length > 0) servers.Add(new("(localdb)\\" + name, "LocalDB", "local"));
            }
            return new(servers.DistinctBy(item => item.Server, StringComparer.OrdinalIgnoreCase).OrderBy(item => item.Server).ToList());
        }
        catch (Exception) { return new(servers, "Some local SQL Server registrations could not be read. Enter a server name directly if it is missing."); }
    }
}

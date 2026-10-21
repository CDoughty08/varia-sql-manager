using System.Text.Json;
using Varia.Backend.Entra;

namespace Varia.Backend.Tests;

/// <summary>Microsoft Entra ID against a real tenant, on request only: VARIA_TEST_ENTRA_SERVER (an Azure SQL server),
/// VARIA_TEST_ENTRA_DATABASE (optional: the database the service principal's user is in), VARIA_TEST_ENTRA_SP_CLIENT_ID and
/// VARIA_TEST_ENTRA_SP_SECRET run Service Principal; VARIA_TEST_ENTRA_DEFAULT=1 adds Entra Default after az login. The
/// secret is never printed.</summary>
internal static class EntraLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, JsonSerializerOptions json)
    {
        var server = Environment.GetEnvironmentVariable("VARIA_TEST_ENTRA_SERVER");
        var clientId = Environment.GetEnvironmentVariable("VARIA_TEST_ENTRA_SP_CLIENT_ID");
        var secret = Environment.GetEnvironmentVariable("VARIA_TEST_ENTRA_SP_SECRET");
        if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(clientId) || string.IsNullOrEmpty(secret))
        {
            Console.WriteLine("Live Microsoft Entra checks skipped. Set VARIA_TEST_ENTRA_SERVER, VARIA_TEST_ENTRA_SP_CLIENT_ID and VARIA_TEST_ENTRA_SP_SECRET (and VARIA_TEST_ENTRA_DEFAULT=1 after az login) to run them against a tenant.");
            return;
        }
        var database = Environment.GetEnvironmentVariable("VARIA_TEST_ENTRA_DATABASE") ?? "";
        using var service = new SqlService();
        JsonElement Args(object value) => JsonSerializer.SerializeToElement(value, json);
        async Task<ConnectionInfo> ConnectAsync(ConnectOptions options) => (ConnectionInfo)await service.DispatchAsync("connections.connect", Args(options), json);
        var principal = new ConnectOptions(server, database, "entraServicePrincipal", clientId, secret, false);
        var info = await ConnectAsync(principal);
        try
        {
            check(info.Login is { Length: > 0 }, "Service Principal connects, and SUSER_SNAME() names the signed-in principal");
            var root = (ExplorerChildrenResult)await service.DispatchAsync("explorer.children",
                Args(new ExplorerChildrenArgs(info.Id, Guid.NewGuid().ToString(), new NodeRefDto("object", new ObjectRefDto("server")))), json);
            check(root.Error is null && root.Nodes.Count > 0, "Object Explorer loads the server's folders over Entra pool connections");
            var target = new ObjectRefDto("database", Database: info.Database);
            var script = (ScriptResult)await service.DispatchAsync("scripting.script",
                Args(new ScriptArgs(info.Id, Guid.NewGuid().ToString(), [target], "create", ScriptingLiveChecks.Defaults(json))), json);
            check(script.Error is null && script.Text?.Contains("CREATE DATABASE", StringComparison.Ordinal) == true, "Script As works through SMO over an Entra connection");
        }
        finally { await service.DispatchAsync("connections.disconnect", Args(new ConnectionArgs(info.Id)), json); }
        try
        {
            await ConnectAsync(principal with { Password = secret + "-wrong" });
            check(false, "a wrong client secret was accepted");
        }
        catch (RequestException error)
        {
            check(error.Code == "AUTH_ENTRA" && error.Message == EntraFailures.Messages.BadSecret && error.Details?.Number == 7000215 && !error.Message.Contains(secret, StringComparison.Ordinal),
                "a wrong client secret answers AUTH_ENTRA with AADSTS7000215, and never echoes the secret");
        }
        if (Environment.GetEnvironmentVariable("VARIA_TEST_ENTRA_DEFAULT") != "1") return;
        var chain = await ConnectAsync(new ConnectOptions(server, database, "entraDefault", null, null, false));
        try { check(chain.Login is { Length: > 0 }, "Entra Default connects with the developer's az login"); }
        finally { await service.DispatchAsync("connections.disconnect", Args(new ConnectionArgs(chain.Id)), json); }
    }
}

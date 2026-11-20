using System.ComponentModel;
using System.Runtime.Versioning;
using System.ServiceProcess;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>A Windows service's state as the Service Control Manager reports it (SERVICE_STATUS.dwCurrentState).</summary>
internal enum AgentServiceStatus { Stopped = 1, StartPending = 2, StopPending = 3, Running = 4, ContinuePending = 5, PausePending = 6, Paused = 7 }

/// <summary>Why the Service Control Manager refused: access denied (Windows error 5), the machine or its SCM unreachable (RPC errors, an
/// unknown host), no such service (1060), the service disabled (1058), or anything else (its Windows code).</summary>
internal enum ServiceFailure { Denied, Unreachable, NotFound, Disabled, Other }

internal sealed class ServiceControlException(ServiceFailure failure, int code) : Exception("The Service Control Manager refused (Windows error " + code + ").")
{
    public ServiceFailure Failure { get; } = failure;
    public int Code { get; } = code;
}

/// <summary>The seam over the Service Control Manager (AG-2): Windows' own client, or the offline checks' fake. Each call may block for as
/// long as RPC takes; <see cref="AgentServiceControl"/> bounds it. Start of a running service and Stop of a stopped one are not failures.</summary>
internal interface IServiceControl
{
    AgentServiceStatus Query(string machine, string service);
    void Start(string machine, string service);
    void Stop(string machine, string service);
}

/// <summary>Windows' Service Control Manager client (System.ServiceProcess.ServiceController), as the Windows user Varia runs as.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsServiceControl : IServiceControl
{
    public AgentServiceStatus Query(string machine, string service) => Call(machine, service, controller => (AgentServiceStatus)(int)controller.Status);

    public void Start(string machine, string service) => Call(machine, service, controller =>
    {
        try { controller.Start(); }
        // 1056: already running.
        catch (InvalidOperationException error) when (Win32(error) == 1056) { }
        return 0;
    });

    public void Stop(string machine, string service) => Call(machine, service, controller =>
    {
        try { controller.Stop(); }
        // 1062: not started.
        catch (InvalidOperationException error) when (Win32(error) == 1062) { }
        return 0;
    });

    private static T Call<T>(string machine, string service, Func<ServiceController, T> work)
    {
        try
        {
            using var controller = new ServiceController(service, machine);
            return work(controller);
        }
        catch (InvalidOperationException error) when (Win32(error) is { } code) { throw new ServiceControlException(AgentServiceControl.Classify(code), code); }
        catch (Win32Exception error) { throw new ServiceControlException(AgentServiceControl.Classify(error.NativeErrorCode), error.NativeErrorCode); }
    }

    private static int? Win32(Exception error) => error.InnerException is Win32Exception win32 ? win32.NativeErrorCode : null;
}

/// <summary>SQL Server Agent's Start, Stop and Restart (AG-2): its service on the machine SQL Server reports
/// (SERVERPROPERTY('ComputerNamePhysicalNetBIOS')), named SQLSERVERAGENT or SQLAgent$&lt;instance&gt;, through the Service Control Manager as
/// the Windows user Varia runs as. The names come from the server, so they are checked against strict patterns before any call. Every call
/// is bounded (agentLimits.serviceStatementMs, serviceReadMs) and a wait polls the state every servicePollMs up to serviceWaitMs. The state
/// stays SQL's elsewhere (Object Explorer's chip reads xp_servicecontrol QueryState); only these verbs ask the SCM.</summary>
internal sealed partial class AgentServiceControl(IServiceControl control, AgentCatalog? catalog = null)
{
    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;

    // A NetBIOS computer name: at most 15 characters of letters, digits and hyphens (no dots: never a DNS name or an address).
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9-]{0,14}\z", RegexOptions.CultureInvariant)]
    private static partial Regex MachinePattern();
    // An instance name: at most 16 characters, a letter or underscore first, then letters, digits, underscores and dollar signs.
    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_$]{0,15}\z", RegexOptions.CultureInvariant)]
    private static partial Regex InstancePattern();

    public static bool ValidMachine(string? machine) => machine is not null && MachinePattern().IsMatch(machine);

    /// <summary>The Agent service of an instance (null or MSSQLSERVER: the default), or null when the name is not a valid instance name.</summary>
    public static string? ServiceName(string? instance) =>
        instance is null || string.Equals(instance, "MSSQLSERVER", StringComparison.OrdinalIgnoreCase) ? "SQLSERVERAGENT"
        : InstancePattern().IsMatch(instance) ? "SQLAgent$" + instance : null;

    /// <summary>A Windows error as a failure kind.</summary>
    public static ServiceFailure Classify(int code) => code switch
    {
        5 => ServiceFailure.Denied,
        // RPC server unavailable or too busy, the call failed, the endpoint mapper has none, the network path or name was not found.
        1722 or 1723 or 1726 or 1727 or 1753 or 53 or 67 or 1231 or 1203 => ServiceFailure.Unreachable,
        1060 => ServiceFailure.NotFound,
        1058 => ServiceFailure.Disabled,
        _ => ServiceFailure.Other
    };

    /// <summary>A failure as an action error code and Varia's own message (never the SCM's text).</summary>
    public static (string Code, string Message) Describe(ServiceControlException error, string machine, string service) => error.Failure switch
    {
        ServiceFailure.Denied => ("PERMISSION_DENIED", "Starting and stopping SQL Server Agent needs Windows administrator rights on " + machine + "."),
        ServiceFailure.Unreachable => ("SERVICE_UNREACHABLE", "Varia could not reach the Service Control Manager on " + machine + " (Windows error " + error.Code
            + "). Check that the machine is reachable from here and that remote service management is allowed through its firewall."),
        ServiceFailure.NotFound => ("NOT_FOUND", "There is no service " + service + " on " + machine + "."),
        ServiceFailure.Disabled => ("NOT_SUPPORTED", "The SQL Server Agent service is disabled. Change its start mode in SQL Server Configuration Manager first."),
        _ => ("SQL_ERROR", "The Service Control Manager on " + machine + " refused (Windows error " + error.Code + ").")
    };

    /// <summary>A state's name in replies (src/shared/actions/schema.ts agentServiceStates).</summary>
    public static string StateName(AgentServiceStatus? status) => status switch
    {
        AgentServiceStatus.Stopped => "stopped",
        AgentServiceStatus.StartPending => "startPending",
        AgentServiceStatus.StopPending => "stopPending",
        AgentServiceStatus.Running => "running",
        AgentServiceStatus.ContinuePending => "continuePending",
        AgentServiceStatus.PausePending => "pausePending",
        AgentServiceStatus.Paused => "paused",
        _ => "unreadable"
    };

    private TimeSpan Limit(string name) => TimeSpan.FromMilliseconds(catalog.Limit(name));

    /// <summary>Runs one blocking SCM call off the caller's thread within <paramref name="limit"/>; Stop stops the wait (the call itself
    /// runs on until RPC returns, and its outcome is read again by the next step or the final read).</summary>
    private static async Task<T> Bounded<T>(Func<T> call, TimeSpan limit, string what, CancellationToken token)
    {
        try { return await Task.Run(call, CancellationToken.None).WaitAsync(limit, token).ConfigureAwait(false); }
        catch (System.TimeoutException) { throw new ServiceTimeoutException(what + " took longer than " + (int)limit.TotalSeconds + " seconds."); }
    }

    public Task<AgentServiceStatus> QueryAsync(string machine, string service, CancellationToken token) =>
        Bounded(() => control.Query(machine, service), Limit("serviceReadMs"), "Reading the service's state", token);

    public Task StartAsync(string machine, string service, CancellationToken token) =>
        Bounded(() => { control.Start(machine, service); return 0; }, Limit("serviceStatementMs"), "Starting the service", token);

    public Task StopAsync(string machine, string service, CancellationToken token) =>
        Bounded(() => { control.Stop(machine, service); return 0; }, Limit("serviceStatementMs"), "Stopping the service", token);

    /// <summary>Polls until the service reaches <paramref name="wanted"/>, within serviceWaitMs. A stopped service while waiting for it to
    /// run means it failed to start (Agent ends itself when it cannot reach SQL Server, or its account is refused): after a Start that was
    /// sent (<paramref name="started"/>) at once, since the SCM reports Start Pending as soon as it accepts one, otherwise once it was seen
    /// starting.</summary>
    public async Task WaitAsync(string machine, string service, AgentServiceStatus wanted, CancellationToken token, bool started = false)
    {
        var deadline = DateTime.UtcNow + Limit("serviceWaitMs");
        var poll = Limit("servicePollMs");
        var pending = started;
        // Whether the SCM took the Start: once it reports Start Pending, a later Stop Pending is the service falling over.
        var accepted = false;
        while (true)
        {
            var state = await QueryAsync(machine, service, token).ConfigureAwait(false);
            if (state == wanted) return;
            // The SCM refuses a Start while the service is still stopping (1056, read as already running), so nothing was started.
            if (wanted == AgentServiceStatus.Running && started && !accepted && state == AgentServiceStatus.StopPending) throw new ServiceStillStoppingException();
            accepted |= state == AgentServiceStatus.StartPending;
            if (wanted == AgentServiceStatus.Running && state == AgentServiceStatus.Stopped && pending) throw new ServiceStoppedException();
            pending |= state == AgentServiceStatus.StartPending;
            if (DateTime.UtcNow >= deadline)
                throw new ServiceTimeoutException("SQL Server Agent did not reach " + (wanted == AgentServiceStatus.Running ? "Running" : "Stopped") + " within " + (int)Limit("serviceWaitMs").TotalSeconds
                    + " seconds; it is " + StateName(state) + ". Refresh Object Explorer to see where it got to.");
            await Task.Delay(poll, token).ConfigureAwait(false);
        }
    }
}

/// <summary>An SCM call or a wait past its bound.</summary>
internal sealed class ServiceTimeoutException(string message) : Exception(message);

/// <summary>A Start sent while the service was still stopping, which the SCM does not take.</summary>
internal sealed class ServiceStillStoppingException() : Exception("SQL Server Agent is still stopping, so it was not started. Start it again once it has stopped.");

/// <summary>The service stopped again while it was starting.</summary>
internal sealed class ServiceStoppedException() : Exception("SQL Server Agent stopped again while it was starting. Its error log (SQLAGENT.OUT) says why.");

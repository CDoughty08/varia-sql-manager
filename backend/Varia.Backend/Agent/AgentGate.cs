namespace Varia.Backend.Agent;

/// <summary>SQL Server Agent's release gate as the backend reads it (src/shared/agent/gate.ts): the sidecar inherits main's
/// environment, so exactly VARIA_AGENT_PREVIEW=1 opens it. Work the renderer does not ask for, such as Search Objects' index
/// build, reads it so no Agent SQL runs while the gate is shut; AG-9 removes it.</summary>
internal static class AgentGate
{
    public static bool Enabled { get; } = Environment.GetEnvironmentVariable("VARIA_AGENT_PREVIEW") == "1";
}

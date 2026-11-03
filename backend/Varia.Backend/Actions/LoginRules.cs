namespace Varia.Backend.Actions;

/// <summary>One login subtype's rule per verb ('allowed', 'greyed' or 'hidden'), and the message id each greyed verb answers with.</summary>
internal sealed record LoginRuleJson(string Subtype, string Disable, string Enable, string Unlock, string Rename, string Delete, Dictionary<string, string> Greyed);
/// <summary>The logins block of actions-catalog.json (src/shared/actions/logins.ts loginsCatalog()).</summary>
internal sealed record LoginRulesJson(Dictionary<string, long> Limits, Dictionary<string, string> Messages, List<string> OwnRefuses, List<LoginRuleJson> Rules, int SaPrincipalId,
    string ScriptHeader, Dictionary<string, string> TypeSubtypes);

/// <summary>Login subtypes and the protected-principal rules (D4 §4) as logins.ts declares them: Object Explorer's login
/// subtype, and the refusal the login preflight answers for a verb. C# holds no rules of its own.</summary>
internal sealed class LoginRules
{
    public static readonly IReadOnlyList<string> Verbs = ["disable", "enable", "unlock", "rename", "delete"];

    private readonly Dictionary<string, LoginRuleJson> rules;
    private readonly LoginRulesJson json;

    public LoginRules(LoginRulesJson json)
    {
        this.json = json;
        rules = json.Rules.ToDictionary(rule => rule.Subtype, StringComparer.Ordinal);
        if (json.TypeSubtypes.Values.Any(subtype => !rules.ContainsKey(subtype)) || !rules.ContainsKey("sa") || !rules.ContainsKey("system"))
            throw new InvalidOperationException("The login rules do not cover every login subtype.");
    }

    public IReadOnlyCollection<string> Subtypes => rules.Keys;
    /// <summary>sys.server_principals.type letters the Logins folder lists.</summary>
    public IReadOnlyCollection<string> Types => json.TypeSubtypes.Keys;

    /// <summary>A login's subtype: sa by principal_id (whatever its name), SQL Server's own by a name that starts and ends with
    /// ##, else its type; null for a type the Logins folder does not list.</summary>
    public string? SubtypeOf(int principalId, string? type, string name)
    {
        if (type is null || !json.TypeSubtypes.TryGetValue(type.Trim(), out var byType)) return null;
        if (principalId == json.SaPrincipalId) return "sa";
        if (name.Length >= 4 && name.StartsWith("##", StringComparison.Ordinal) && name.EndsWith("##", StringComparison.Ordinal)) return "system";
        return byType;
    }

    /// <summary>'allowed', 'greyed' or 'hidden'.</summary>
    public string Rule(string subtype, string verb)
    {
        var rule = rules.TryGetValue(subtype, out var found) ? found : throw new InvalidOperationException("Unknown login subtype " + subtype);
        return verb switch
        {
            "disable" => rule.Disable,
            "enable" => rule.Enable,
            "unlock" => rule.Unlock,
            "rename" => rule.Rename,
            "delete" => rule.Delete,
            _ => throw new InvalidOperationException("Unknown login verb " + verb)
        };
    }

    /// <summary>The message id that refuses <paramref name="verb"/> for a login the preflight read, or null: its subtype's rule,
    /// the connection's own login, then ALTER ANY LOGIN, and CONTROL SERVER for a sysadmin member (logins.ts loginRefusal).</summary>
    public string? Refusal(LoginFactsDto facts, string verb)
    {
        if (Rule(facts.Subtype, verb) != "allowed") return rules[facts.Subtype].Greyed.TryGetValue(verb, out var id) ? id : "notOffered";
        if (facts.Own && json.OwnRefuses.Contains(verb)) return "own";
        if (!facts.CanAlter) return "alterAnyLogin";
        if (facts.Sysadmin && !facts.CanControlServer) return "controlServer";
        return null;
    }

    public string Message(string id) => json.Messages.TryGetValue(id, out var text) ? text : throw new InvalidOperationException("Unknown login message " + id);

    /// <summary>The comment above a script whose password is the <password> placeholder (New Login's Script Action).</summary>
    public string ScriptHeader => json.ScriptHeader;

    public long Limit(string key) => json.Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown login limit " + key);
}

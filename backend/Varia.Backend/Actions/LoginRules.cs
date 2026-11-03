namespace Varia.Backend.Actions;

/// <summary>One login subtype's rule per verb ('allowed', 'greyed' or 'hidden'), and the message id each greyed verb answers with.</summary>
internal sealed record LoginRuleJson(string Subtype, string Disable, string Enable, string Unlock, string Rename, string Delete, Dictionary<string, string> Greyed);
/// <summary>The logins block of actions-catalog.json (src/shared/actions/logins.ts loginsCatalog()).</summary>
internal sealed record LoginRulesJson(Dictionary<string, long> Limits, List<string> LockProperties, Dictionary<string, string> Messages, List<string> OwnRefuses, List<LoginRuleJson> Rules, int SaPrincipalId,
    Dictionary<string, string> TypeSubtypes, LoginDetailJson Detail, List<string> NoBackslash);
/// <summary>The words of a Logins folder row's detail (logins.ts loginDetailWords): its kind by type letter, then its state and
/// password policy.</summary>
internal sealed record LoginDetailJson(Dictionary<string, string> Types, string Disabled, string ConnectDenied, string PolicyChecked, string ExpirationChecked);

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
        if (json.Detail is null || json.TypeSubtypes.Keys.Any(type => !json.Detail.Types.ContainsKey(type)))
            throw new InvalidOperationException("The login detail words do not name every login type.");
        // ActionSql.LoginLock reads exactly the properties logins.ts allows (critic A15).
        if (json.LockProperties is null || !json.LockProperties.SequenceEqual(ActionSql.LoginLockProperties, StringComparer.Ordinal))
            throw new InvalidOperationException("The login lock-out properties differ from the catalogue's.");
    }

    public IReadOnlyCollection<string> Subtypes => rules.Keys;
    /// <summary>The LOGINPROPERTY properties logins.ts allows ActionSql.LoginLock to read.</summary>
    public IReadOnlyList<string> LockProperties => json.LockProperties;
    /// <summary>sys.server_principals.type letters the Logins folder lists.</summary>
    public IReadOnlyCollection<string> Types => json.TypeSubtypes.Keys;

    /// <summary>A login's subtype: sa by principal_id (whatever its name), SQL Server's own by a name that starts and ends with
    /// ##, else its type; null for a type the Logins folder does not list.</summary>
    public string? SubtypeOf(int principalId, string? type, string name)
    {
        if (type is null || !json.TypeSubtypes.TryGetValue(type.Trim(), out var byType)) return null;
        if (principalId == json.SaPrincipalId) return "sa";
        if (SystemName(name)) return "system";
        return byType;
    }

    /// <summary>Whether a login's name is SQL Server's own form, ##…## (logins.ts isSystemLoginName). SQL Server compares names
    /// without trailing spaces, so "##x## " names the same login and counts too.</summary>
    public static bool SystemName(string name)
    {
        var trimmed = name.TrimEnd(' ');
        return trimmed.Length >= 4 && trimmed.StartsWith("##", StringComparison.Ordinal) && trimmed.EndsWith("##", StringComparison.Ordinal);
    }

    /// <summary>A login row's status (logins.ts loginStatusOf): disabled, else noAccess while CONNECT SQL is denied, else none.
    /// The two were one status before D4a; they stay apart because Enable does not lift a DENY CONNECT SQL.</summary>
    public string? StatusOf(bool disabled, bool connectDenied) => disabled ? "disabled" : connectDenied ? "noAccess" : null;

    /// <summary>A login row's detail (logins.ts loginDetail): its kind, then Disabled, Permission to connect denied (both when
    /// both apply) and the password policy flags, joined with " · ".</summary>
    public string Detail(string type, bool disabled, bool connectDenied, bool policyChecked, bool expirationChecked)
    {
        var words = json.Detail;
        var parts = new List<string>();
        if (words.Types.TryGetValue(type.Trim(), out var kind)) parts.Add(kind);
        if (disabled) parts.Add(words.Disabled);
        if (connectDenied) parts.Add(words.ConnectDenied);
        if (policyChecked) parts.Add(words.PolicyChecked);
        if (expirationChecked) parts.Add(words.ExpirationChecked);
        return string.Join(" · ", parts);
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

    /// <summary>The message id that refuses keeping the password to unlock a login, or null (logins.ts unlockRefusal, after the
    /// rules' Refusal): a login that is not a SQL Server login enforcing the password policy (turning the policy on would change
    /// it, not unlock it), one that must change its password (SQL Server refuses CHECK_POLICY = OFF then, 15128), and, unless
    /// <paramref name="script"/>, one that is not locked out. A script is for later, when it may be.</summary>
    public static string? UnlockRefusal(LoginFactsDto facts, LoginLockFactsDto state, bool script = false) =>
        facts.Type.Trim() != "S" || facts.PolicyChecked != true ? "unlockNoPolicy" : state.MustChange ? "unlockMustChange" : !script && !state.Locked ? "notLocked" : null;

    /// <summary>The message id that refuses a login's new name, or null: SQL Server's own form for every subtype, then a backslash
    /// in the name of a login SQL Server authenticates itself (logins.ts loginNameRefusal; SQL Server would answer 15021).</summary>
    public string? NameRefusal(string subtype, string newName) =>
        SystemName(newName) ? "systemName" : json.NoBackslash.Contains(subtype) && newName.Contains('\\') ? "sqlBackslash" : null;

    public string Message(string id) => json.Messages.TryGetValue(id, out var text) ? text : throw new InvalidOperationException("Unknown login message " + id);

    public long Limit(string key) => json.Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown login limit " + key);
}

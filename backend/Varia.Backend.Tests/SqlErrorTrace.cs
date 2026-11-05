using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Microsoft.Data.SqlClient.Diagnostics;

namespace Varia.Backend.Tests;

/// <summary>Live checks only: what SqlClient held for each command the server refused while a trace is open, from its
/// diagnostic events, so a failure can say where garbled text came from. The concurrent dependency check once failed in CI
/// (Linux, managed SNI) with "Msg 102: Incorrect syntax near '楀ᚌ'": UTF-16 code units 0x6940 0x168C, bytes 40 69 8C 16,
/// which no T-SQL template of SMO's or Varia's holds. If the command text SqlClient was given holds such characters, a
/// managed string was corrupted before it reached SqlClient (SMO's statement building, say); if it is plain ASCII, the bytes
/// changed on the way to the server or in it. A record names the error number, the text's length, its parameters and the
/// code points beyond ASCII, never the SQL itself.</summary>
internal sealed class SqlErrorTrace : IDisposable
{
    private const int MaxRecords = 8, MaxCodePoints = 16;
    private static readonly Lock gate = new();
    private static SqlErrorTrace? current;
    private static int subscribed;
    private readonly List<string> records = [];

    private SqlErrorTrace() { }

    /// <summary>Records the process's refused commands until disposed; one trace at a time.</summary>
    public static SqlErrorTrace Start()
    {
        if (Interlocked.Exchange(ref subscribed, 1) == 0) _ = DiagnosticListener.AllListeners.Subscribe(new Listeners());
        var trace = new SqlErrorTrace();
        lock (gate)
        {
            if (current is not null) throw new InvalidOperationException("Another SqlErrorTrace is open.");
            current = trace;
        }
        return trace;
    }

    /// <summary>The records so far, or "no command failed".</summary>
    public string Summary()
    {
        lock (gate) return records.Count == 0 ? "no command failed" : string.Join("; ", records);
    }

    public void Dispose()
    {
        lock (gate) if (current == this) current = null;
    }

    /// <summary>One refused command as a record: its error, the length of its text and the code points beyond ASCII in its
    /// text and its string parameters' values.</summary>
    internal static string Describe(SqlCommand command, Exception error)
    {
        var text = command.CommandText ?? "";
        var parameters = command.Parameters.Cast<SqlParameter>().ToList();
        string Beyond(IEnumerable<string> values)
        {
            var points = values.SelectMany(value => value.Where(ch => ch > '~')).Distinct().Take(MaxCodePoints + 1)
                .Select(ch => "U+" + ((int)ch).ToString("X4", CultureInfo.InvariantCulture)).ToList();
            return points.Count == 0 ? "none" : string.Join(" ", points.Take(MaxCodePoints)) + (points.Count > MaxCodePoints ? " ..." : "");
        }
        var number = error is SqlException sql ? "Msg " + sql.Number.ToString(CultureInfo.InvariantCulture) : error.GetType().Name;
        return number + ": a command of " + text.Length.ToString(CultureInfo.InvariantCulture) + " characters with " + parameters.Count.ToString(CultureInfo.InvariantCulture)
            + " parameters; beyond ASCII in its text: " + Beyond([text]) + ", in its parameters: " + Beyond(parameters.Select(parameter => parameter.Value).OfType<string>());
    }

    private void Add(string record)
    {
        lock (gate) if (records.Count < MaxRecords) records.Add(record);
    }

    private sealed class Listeners : IObserver<DiagnosticListener>
    {
        public void OnNext(DiagnosticListener listener)
        {
            if (listener.Name == "SqlClientDiagnosticListener") listener.Subscribe(new Events(), (name, _, _) => name == "Microsoft.Data.SqlClient.WriteCommandError" && current is not null);
        }
        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }

    private sealed class Events : IObserver<KeyValuePair<string, object?>>
    {
        public void OnNext(KeyValuePair<string, object?> value)
        {
            if (value.Value is SqlClientCommandError { Command: { } command, Exception: { } error } && current is { } trace) trace.Add(Describe(command, error));
        }
        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }
}

using System.Collections;
using System.Reflection;

namespace Varia.Backend.Scripting;

/// <summary>SMO 181's dependency discovery (SqlEnum's internal SqlEnumDependencies, behind DependencyWalker and the
/// Scripter's Generate script for dependent objects) maps its rows' type numbers to URN types through a static SortedList
/// that its first caller assigns and only then fills, without a lock. Two jobs discovering at once while it is empty (the
/// process's first two scripts with dependent objects, on any connections) can see it part-filled: a SortedList read during
/// an insert can answer a neighbour's entry, so the walk names its own root by the wrong type and fails with "Urn ... is
/// missing from the dependencies list" (or a NullReferenceException). <see cref="Ensure"/> fills it under a lock of Varia's
/// before any job's SMO runs, so no job reads it while it fills.</summary>
internal static class SmoDependencyTypes
{
    private static readonly Lock gate = new();
    private static readonly Type Dependencies = Type.GetType("Microsoft.SqlServer.Management.Smo.SqlEnumDependencies, Microsoft.SqlServer.SqlEnum", throwOnError: true)!;
    private static readonly PropertyInfo Table = Dependencies.GetProperty("TypeConvertTable", BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new InvalidOperationException("SMO's dependency type table moved: review SmoDependencyTypes for this SMO version.");
    private static readonly FieldInfo SingletonField = Dependencies.GetField("sqlEnumDependenciesSingleton", BindingFlags.NonPublic | BindingFlags.Static)
        ?? throw new InvalidOperationException("SMO's dependency type table moved: review SmoDependencyTypes for this SMO version.");
    private static FieldInfo? tableField;
    /// <summary>Set once Varia's call has filled the table: SMO assigns the field before it fills it, so the field alone does
    /// not say the table is whole.</summary>
    private static volatile bool ready;

    private static object Singleton => SingletonField.GetValue(null)!;
    private static FieldInfo TableField => tableField ??= Singleton.GetType().GetField("m_typeConvertTable", BindingFlags.NonPublic | BindingFlags.Instance)
        ?? throw new InvalidOperationException("SMO's dependency type table moved: review SmoDependencyTypes for this SMO version.");

    /// <summary>The table's entries once filled (live checks compare them with what a race could leave).</summary>
    internal static int Count => (TableField.GetValue(Singleton) as SortedList)?.Count ?? 0;

    /// <summary>Fills SMO's table if Varia has not yet; a job calls this before its SMO runs. Once filled it is never written
    /// again, so later calls only read a flag.</summary>
    public static void Ensure()
    {
        if (ready) return;
        lock (gate)
        {
            if (ready) return;
            Table.GetValue(null);
            ready = true;
        }
    }

    /// <summary>Live checks only: empties the table again, as a new process starts, so concurrent jobs race to fill it.</summary>
    internal static void Reset()
    {
        lock (gate)
        {
            TableField.SetValue(Singleton, null);
            ready = false;
        }
    }
}

using System.Text;

namespace Varia.Backend.Language;

/// <summary>Curated T-SQL dialect reference: keywords, data types, date parts, system globals (@@), built-in functions
/// with hover signatures, and identifier quoting helpers. Pure in-process data, zero external calls.</summary>
internal static class TsqlCatalog
{
    internal sealed record FunctionInfo(string Name, string ReturnType, string Summary, string[] Signatures, bool Niladic = false);
    internal sealed record TypeInfo(string Name, string Summary, string? Snippet = null);
    internal sealed record DatePartInfo(string Name, string Abbreviations, string Summary);
    internal sealed record GlobalInfo(string Name, string ReturnType, string Summary);

    internal static readonly IReadOnlyList<string> StatementStarterKeywords =
    [
        "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "DECLARE", "SET",
        "CREATE", "ALTER", "DROP", "TRUNCATE", "EXEC", "EXECUTE", "USE",
        "BEGIN", "IF", "ELSE", "WHILE", "BREAK", "CONTINUE", "RETURN",
        "TRY", "THROW", "RAISERROR", "PRINT", "WAITFOR",
        "COMMIT", "ROLLBACK", "SAVE", "GRANT", "REVOKE", "DENY", "GO"
    ];

    internal static readonly IReadOnlyList<string> AfterFromTableKeywords =
    [
        "AS", "ON", "INNER JOIN", "LEFT JOIN", "LEFT OUTER JOIN", "RIGHT JOIN", "RIGHT OUTER JOIN",
        "FULL OUTER JOIN", "CROSS JOIN", "CROSS APPLY", "OUTER APPLY",
        "WHERE", "GROUP BY", "HAVING", "ORDER BY", "PIVOT", "UNPIVOT",
        "UNION", "UNION ALL", "INTERSECT", "EXCEPT", "WITH (NOLOCK)", "OPTION", "FOR JSON", "FOR XML"
    ];

    internal static readonly IReadOnlyList<string> ExpressionKeywords =
    [
        "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "IN", "EXISTS",
        "BETWEEN", "LIKE", "IS", "NULL", "TRUE", "FALSE", "DISTINCT", "TOP", "ALL", "ANY", "SOME",
        "AS", "ASC", "DESC", "OVER", "PARTITION BY", "ORDER BY", "FROM", "WHERE", "GROUP BY", "HAVING",
        "CAST", "CONVERT", "TRY_CAST", "TRY_CONVERT", "COLLATE", "CURRENT_TIMESTAMP", "CURRENT_USER", "SESSION_USER", "SYSTEM_USER"
    ];

    internal static readonly IReadOnlySet<string> ReservedKeywords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUTHORIZATION", "BACKUP", "BEGIN", "BETWEEN", "BREAK",
        "BROWSE", "BULK", "BY", "CASCADE", "CASE", "CHECK", "CHECKPOINT", "CLOSE", "CLUSTERED", "COALESCE",
        "COLLATE", "COLUMN", "COMMIT", "COMPUTE", "CONSTRAINT", "CONTAINS", "CONTAINSTABLE", "CONTINUE",
        "CONVERT", "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP",
        "CURRENT_USER", "CURSOR", "DATABASE", "DBCC", "DEALLOCATE", "DECLARE", "DEFAULT", "DELETE", "DENY",
        "DESC", "DISK", "DISTINCT", "DISTRIBUTED", "DOUBLE", "DROP", "DUMP", "ELSE", "END", "ERRLVL", "ESCAPE",
        "EXCEPT", "EXEC", "EXECUTE", "EXISTS", "EXIT", "EXTERNAL", "FETCH", "FILE", "FILLFACTOR", "FOR",
        "FOREIGN", "FREETEXT", "FREETEXTTABLE", "FROM", "FULL", "FUNCTION", "GOTO", "GRANT", "GROUP", "HAVING",
        "HOLDLOCK", "IDENTITY", "IDENTITY_INSERT", "IDENTITYCOL", "IF", "IN", "INDEX", "INNER", "INSERT",
        "INTERSECT", "INTO", "IS", "JOIN", "KEY", "KILL", "LEFT", "LIKE", "LINENO", "LOAD", "MERGE", "NATIONAL",
        "NOCHECK", "NONCLUSTERED", "NOT", "NULL", "NULLIF", "OF", "OFF", "OFFSETS", "ON", "OPEN",
        "OPENDATASOURCE", "OPENQUERY", "OPENROWSET", "OPENXML", "OPTION", "OR", "ORDER", "OUTER", "OVER",
        "PERCENT", "PIVOT", "PLAN", "PRECISION", "PRIMARY", "PRINT", "PROC", "PROCEDURE", "PUBLIC", "RAISERROR",
        "READ", "READTEXT", "RECONFIGURE", "REFERENCES", "REPLICATION", "RESTORE", "RESTRICT", "RETURN",
        "REVERT", "REVOKE", "RIGHT", "ROLLBACK", "ROWCOUNT", "ROWGUIDCOL", "RULE", "SAVE", "SCHEMA",
        "SECURITYAUDIT", "SELECT", "SEMANTICKEYPHRASETABLE", "SEMANTICSIMILARITYDETAILSTABLE",
        "SEMANTICSIMILARITYTABLE", "SESSION_USER", "SET", "SETUSER", "SHUTDOWN", "SOME", "STATISTICS",
        "SYSTEM_USER", "TABLE", "TABLESAMPLE", "TEXTSIZE", "THEN", "TO", "TOP", "TRAN", "TRANSACTION",
        "TRIGGER", "TRUNCATE", "TRY_CONVERT", "TSEQUAL", "UNION", "UNIQUE", "UNPIVOT", "UPDATE", "UPDATETEXT",
        "USE", "USER", "VALUES", "VARYING", "VIEW", "WAITFOR", "WHEN", "WHERE", "WHILE", "WITH", "WITHIN GROUP",
        "WRITETEXT", "GO"
    };

    internal static readonly IReadOnlyList<TypeInfo> DataTypes =
    [
        new TypeInfo("INT", "4-byte signed integer (-2,147,483,648 to 2,147,483,647)."),
        new TypeInfo("BIGINT", "8-byte signed integer (-2^63 to 2^63-1)."),
        new TypeInfo("SMALLINT", "2-byte signed integer (-32,768 to 32,767)."),
        new TypeInfo("TINYINT", "1-byte unsigned integer (0 to 255)."),
        new TypeInfo("BIT", "Boolean integer value (0, 1, or NULL)."),
        new TypeInfo("DECIMAL", "Fixed precision and scale numeric: DECIMAL(precision, scale).", "DECIMAL(${1:18}, ${2:2})"),
        new TypeInfo("NUMERIC", "Fixed precision and scale numeric (synonym for DECIMAL).", "NUMERIC(${1:18}, ${2:2})"),
        new TypeInfo("MONEY", "8-byte currency value with four decimal places."),
        new TypeInfo("SMALLMONEY", "4-byte currency value with four decimal places."),
        new TypeInfo("FLOAT", "Approximate floating-point number (default 53-bit mantissa)."),
        new TypeInfo("REAL", "4-byte single-precision floating-point number (FLOAT(24))."),
        new TypeInfo("NVARCHAR", "Variable-length Unicode string: NVARCHAR(n | MAX).", "NVARCHAR(${1:100})"),
        new TypeInfo("VARCHAR", "Variable-length non-Unicode string: VARCHAR(n | MAX).", "VARCHAR(${1:100})"),
        new TypeInfo("NCHAR", "Fixed-length Unicode string: NCHAR(n).", "NCHAR(${1:10})"),
        new TypeInfo("CHAR", "Fixed-length non-Unicode string: CHAR(n).", "CHAR(${1:10})"),
        new TypeInfo("DATE", "Calendar date (0001-01-01 through 9999-12-31)."),
        new TypeInfo("TIME", "Time of day without time zone: TIME(scale)."),
        new TypeInfo("DATETIME2", "High-precision date and time (0001-01-01 through 9999-12-31): DATETIME2(scale)."),
        new TypeInfo("DATETIME", "Legacy date and time (1753-01-01 through 9999-12-31, 3.33 ms resolution)."),
        new TypeInfo("SMALLDATETIME", "Date and time rounded to the nearest minute (1900-01-01 through 2079-06-06)."),
        new TypeInfo("DATETIMEOFFSET", "Date and time with time zone offset."),
        new TypeInfo("UNIQUEIDENTIFIER", "16-byte globally unique identifier (GUID)."),
        new TypeInfo("VARBINARY", "Variable-length binary data: VARBINARY(n | MAX).", "VARBINARY(${1:MAX})"),
        new TypeInfo("BINARY", "Fixed-length binary data: BINARY(n).", "BINARY(${1:16})"),
        new TypeInfo("XML", "Native XML document or fragment."),
        new TypeInfo("JSON", "Native binary JSON data type (SQL Server 2025+)."),
        new TypeInfo("SYSNAME", "System-supplied alias for NVARCHAR(128) NOT NULL used for object names."),
        new TypeInfo("SQL_VARIANT", "Stores values of various SQL Server-supported base types."),
        new TypeInfo("GEOGRAPHY", "Round-earth spatial data type."),
        new TypeInfo("GEOMETRY", "Planar (Euclidean) spatial data type."),
        new TypeInfo("HIERARCHYID", "Variable-length system type representing position in a hierarchy."),
        new TypeInfo("ROWVERSION", "Automatically generated unique 8-byte binary version number."),
        new TypeInfo("TIMESTAMP", "Deprecated synonym for ROWVERSION."),
        new TypeInfo("VECTOR", "Fixed-dimension float vector type (SQL Server 2025+): VECTOR(dimensions).", "VECTOR(${1:1536})"),
        new TypeInfo("TEXT", "Legacy large non-Unicode text (prefer VARCHAR(MAX))."),
        new TypeInfo("NTEXT", "Legacy large Unicode text (prefer NVARCHAR(MAX))."),
        new TypeInfo("IMAGE", "Legacy large binary data (prefer VARBINARY(MAX)).")
    ];

    internal static readonly IReadOnlyDictionary<string, TypeInfo> DataTypeMap =
        DataTypes.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);

    internal static readonly IReadOnlyList<DatePartInfo> DateParts =
    [
        new("year", "yy, yyyy", "Calendar year."),
        new("quarter", "qq, q", "Quarter of the year (1â€“4)."),
        new("month", "mm, m", "Month of the year (1â€“12)."),
        new("dayofyear", "dy, y", "Day of the year (1â€“366)."),
        new("day", "dd, d", "Day of the month (1â€“31)."),
        new("week", "wk, ww", "Week of the year."),
        new("weekday", "dw, w", "Day of the week (1â€“7, depends on @@DATEFIRST)."),
        new("hour", "hh", "Hour of the day (0â€“23)."),
        new("minute", "mi, n", "Minute of the hour (0â€“59)."),
        new("second", "ss, s", "Second of the minute (0â€“59)."),
        new("millisecond", "ms", "Millisecond (0â€“999)."),
        new("microsecond", "mcs", "Microsecond (0â€“999999)."),
        new("nanosecond", "ns", "Nanosecond (0â€“999999999)."),
        new("iso_week", "isowk, isoww", "ISO 8601 week number."),
        new("tzoffset", "tz", "Time zone offset in minutes (DATETIMEOFFSET).")
    ];

    internal static readonly IReadOnlySet<string> DatePartFunctions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "DATEADD", "DATEDIFF", "DATEDIFF_BIG", "DATENAME", "DATEPART", "DATETRUNC"
    };

    internal static readonly IReadOnlyList<GlobalInfo> SystemGlobals =
    [
        new("@@ROWCOUNT", "int", "Returns the number of rows affected by the last statement."),
        new("@@TRANCOUNT", "int", "Returns the number of BEGIN TRANSACTION statements active on the current connection."),
        new("@@ERROR", "int", "Returns the error number for the last Transact-SQL statement executed (0 if no error)."),
        new("@@IDENTITY", "numeric(38,0)", "Returns the last-inserted identity value in the current session across all scopes."),
        new("@@FETCH_STATUS", "int", "Returns the status of the last cursor FETCH statement (0 = succeeded, -1 = failed/beyond end, -2 = missing)."),
        new("@@SERVERNAME", "nvarchar(128)", "Returns the name of the local server running SQL Server."),
        new("@@SERVICENAME", "nvarchar(128)", "Returns the registry key name under which SQL Server is running."),
        new("@@SPID", "smallint", "Returns the session ID (SPID) of the current user process."),
        new("@@VERSION", "nvarchar(max)", "Returns SQL Server version, build, edition, and operating system details."),
        new("@@LANGUAGE", "nvarchar(128)", "Returns the name of the language currently being used."),
        new("@@LANGID", "smallint", "Returns the local language identifier (ID) of the current language."),
        new("@@LOCK_TIMEOUT", "int", "Returns the current lock time-out setting in milliseconds for the current session."),
        new("@@NESTLEVEL", "int", "Returns the nesting level of the current stored procedure or trigger execution (0â€“32)."),
        new("@@OPTIONS", "int", "Returns bitmask information about the current SET options."),
        new("@@PROCID", "int", "Returns the object identifier (ID) of the current Transact-SQL module."),
        new("@@DATEFIRST", "tinyint", "Returns the current value of SET DATEFIRST (1 = Monday through 7 = Sunday)."),
        new("@@DBTS", "varbinary(8)", "Returns the current rowversion/timestamp data type value for the current database."),
        new("@@TEXTSIZE", "int", "Returns the current value of the TEXTSIZE option."),
        new("@@CURSOR_ROWS", "int", "Returns the number of qualifying rows currently in the last cursor opened on the connection."),
        new("@@MAX_CONNECTIONS", "int", "Returns the maximum number of simultaneous user connections allowed on an instance."),
        new("@@MAX_PRECISION", "tinyint", "Returns the precision level used by decimal and numeric data types as currently set in the server."),
        new("@@CONNECTIONS", "int", "Returns the number of attempted connections since SQL Server was last started."),
        new("@@CPU_BUSY", "int", "Returns the time in ticks that SQL Server has spent working since it was last started."),
        new("@@IDLE", "int", "Returns the time in ticks that SQL Server has been idle since it was last started."),
        new("@@IO_BUSY", "int", "Returns the time in ticks that SQL Server has spent performing input and output operations."),
        new("@@TOTAL_ERRORS", "int", "Returns the number of disk write errors encountered by SQL Server since startup."),
        new("@@TOTAL_READ", "int", "Returns the number of disk reads by SQL Server since startup."),
        new("@@TOTAL_WRITE", "int", "Returns the number of disk writes by SQL Server since startup."),
        new("@@TIMETICKS", "int", "Returns the number of microseconds per tick."),
        new("@@MICROSOFTVERSION", "int", "Internal SQL Server version integer.")
    ];

    internal static readonly IReadOnlyDictionary<string, GlobalInfo> SystemGlobalMap =
        SystemGlobals.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);

    internal static readonly IReadOnlyList<FunctionInfo> BuiltInFunctions =
    [
        // Aggregates
        new FunctionInfo("COUNT", "int", "Returns the number of items found in a group.", ["COUNT( { [ [ ALL | DISTINCT ] expression ] | * } ) -> int"]),
        new FunctionInfo("COUNT_BIG", "bigint", "Returns the number of items found in a group as bigint.", ["COUNT_BIG( { [ [ ALL | DISTINCT ] expression ] | * } ) -> bigint"]),
        new FunctionInfo("SUM", "numeric", "Returns the sum of all the values, or only the DISTINCT values, in the expression.", ["SUM( [ ALL | DISTINCT ] expression )"]),
        new FunctionInfo("AVG", "numeric", "Returns the average of the values in a group (NULL values are ignored).", ["AVG( [ ALL | DISTINCT ] expression )"]),
        new FunctionInfo("MIN", "any", "Returns the minimum value in the expression.", ["MIN( [ ALL | DISTINCT ] expression )"]),
        new FunctionInfo("MAX", "any", "Returns the maximum value in the expression.", ["MAX( [ ALL | DISTINCT ] expression )"]),
        new FunctionInfo("STRING_AGG", "nvarchar", "Concatenates the values of string expressions with a separator.", ["STRING_AGG( expression, separator ) [ WITHIN GROUP ( ORDER BY order_expr ) ] -> nvarchar/varchar"]),
        new FunctionInfo("APPROX_COUNT_DISTINCT", "bigint", "Returns the approximate number of unique non-null values in a group.", ["APPROX_COUNT_DISTINCT( expression ) -> bigint"]),
        new FunctionInfo("STDEV", "float", "Returns the statistical standard deviation of all values in the specified expression.", ["STDEV( [ ALL | DISTINCT ] expression ) -> float"]),
        new FunctionInfo("STDEVP", "float", "Returns the statistical standard deviation for the population.", ["STDEVP( [ ALL | DISTINCT ] expression ) -> float"]),
        new FunctionInfo("VAR", "float", "Returns the statistical variance of all values in the specified expression.", ["VAR( [ ALL | DISTINCT ] expression ) -> float"]),
        new FunctionInfo("VARP", "float", "Returns the statistical variance for the population.", ["VARP( [ ALL | DISTINCT ] expression ) -> float"]),
        new FunctionInfo("GROUPING", "tinyint", "Indicates whether a specified column expression in a GROUP BY list is aggregated (1) or not (0).", ["GROUPING( column_expression ) -> tinyint"]),
        new FunctionInfo("GROUPING_ID", "int", "Computes the level of grouping for a list of columns.", ["GROUPING_ID( column_expression [, ...n] ) -> int"]),

        // Null & Conditional
        new FunctionInfo("COALESCE", "any", "Evaluates the arguments in order and returns the first non-NULL expression.", ["COALESCE( expression [, ...n] )"]),
        new FunctionInfo("ISNULL", "any", "Replaces NULL with the specified replacement value.", ["ISNULL( check_expression, replacement_value )"]),
        new FunctionInfo("NULLIF", "any", "Returns NULL if the two specified expressions are equal; otherwise returns the first expression.", ["NULLIF( expression1, expression2 )"]),
        new FunctionInfo("IIF", "any", "Returns one of two values depending on whether the Boolean expression evaluates to true or false.", ["IIF( boolean_expression, true_value, false_value )"]),
        new FunctionInfo("CHOOSE", "any", "Returns the item at the specified 1-based index from a list of values.", ["CHOOSE( index, val_1, val_2 [, val_n] )"]),
        new FunctionInfo("GREATEST", "any", "Returns the maximum value from a list of one or more expressions.", ["GREATEST( expression1 [, ...n] )"]),
        new FunctionInfo("LEAST", "any", "Returns the minimum value from a list of one or more expressions.", ["LEAST( expression1 [, ...n] )"]),

        // Conversion & Formatting
        new FunctionInfo("CAST", "data_type", "Converts an expression of one data type to another.", ["CAST( expression AS data_type [ ( length ) ] )"]),
        new FunctionInfo("CONVERT", "data_type", "Converts an expression of one data type to another with optional formatting style.", ["CONVERT( data_type [ ( length ) ], expression [, style ] )"]),
        new FunctionInfo("TRY_CAST", "data_type", "Converts an expression to the specified data type, or returns NULL if the cast fails.", ["TRY_CAST( expression AS data_type [ ( length ) ] )"]),
        new FunctionInfo("TRY_CONVERT", "data_type", "Converts an expression to the specified data type, or returns NULL if conversion fails.", ["TRY_CONVERT( data_type [ ( length ) ], expression [, style ] )"]),
        new FunctionInfo("PARSE", "data_type", "Translates a string expression to the requested date/time or number type using an optional culture.", ["PARSE( string_value AS data_type [ USING culture ] )"]),
        new FunctionInfo("TRY_PARSE", "data_type", "Translates a string expression to the requested type, returning NULL if conversion fails.", ["TRY_PARSE( string_value AS data_type [ USING culture ] )"]),
        new FunctionInfo("FORMAT", "nvarchar", "Returns a value formatted with the specified .NET format string and optional culture.", ["FORMAT( value, format [, culture ] ) -> nvarchar"]),

        // Date & Time
        new FunctionInfo("GETDATE", "datetime", "Returns the current database system timestamp as a datetime value.", ["GETDATE() -> datetime"]),
        new FunctionInfo("GETUTCDATE", "datetime", "Returns the current database system UTC timestamp as a datetime value.", ["GETUTCDATE() -> datetime"]),
        new FunctionInfo("SYSDATETIME", "datetime2(7)", "Returns a datetime2(7) value containing the date and time of the computer running SQL Server.", ["SYSDATETIME() -> datetime2(7)"]),
        new FunctionInfo("SYSUTCDATETIME", "datetime2(7)", "Returns a datetime2(7) value containing the current UTC date and time.", ["SYSUTCDATETIME() -> datetime2(7)"]),
        new FunctionInfo("SYSDATETIMEOFFSET", "datetimeoffset(7)", "Returns a datetimeoffset(7) value containing the date, time, and time zone offset.", ["SYSDATETIMEOFFSET() -> datetimeoffset(7)"]),
        new FunctionInfo("CURRENT_TIMESTAMP", "datetime", "ANSI SQL equivalent to GETDATE().", ["CURRENT_TIMESTAMP -> datetime"], Niladic: true),
        new FunctionInfo("DATEADD", "date/datetime", "Adds a number (signed integer) to a datepart of an input date and returns the modified value.", ["DATEADD( datepart, number, date )"]),
        new FunctionInfo("DATEDIFF", "int", "Returns the count of the specified datepart boundaries crossed between startdate and enddate.", ["DATEDIFF( datepart, startdate, enddate ) -> int"]),
        new FunctionInfo("DATEDIFF_BIG", "bigint", "Returns the bigint count of datepart boundaries crossed between startdate and enddate.", ["DATEDIFF_BIG( datepart, startdate, enddate ) -> bigint"]),
        new FunctionInfo("DATENAME", "nvarchar", "Returns a character string representing the specified datepart of the specified date.", ["DATENAME( datepart, date ) -> nvarchar"]),
        new FunctionInfo("DATEPART", "int", "Returns an integer representing the specified datepart of the specified date.", ["DATEPART( datepart, date ) -> int"]),
        new FunctionInfo("DATETRUNC", "date/datetime", "Returns an input date truncated to a specified datepart (SQL Server 2022+).", ["DATETRUNC( datepart, date )"]),
        new FunctionInfo("DATE_BUCKET", "date/datetime", "Returns the date-time value corresponding to the start of each date-time bucket.", ["DATE_BUCKET( datepart, number, date [, origin ] )"]),
        new FunctionInfo("DATEFROMPARTS", "date", "Returns a date value for the specified year, month, and day.", ["DATEFROMPARTS( year, month, day ) -> date"]),
        new FunctionInfo("DATETIME2FROMPARTS", "datetime2", "Returns a datetime2 value for the specified date and time parts.", ["DATETIME2FROMPARTS( year, month, day, hour, minute, seconds, fractions, precision ) -> datetime2"]),
        new FunctionInfo("EOMONTH", "date", "Returns the last day of the month that contains the specified date, with an optional offset.", ["EOMONTH( start_date [, month_to_add ] ) -> date"]),
        new FunctionInfo("SWITCHOFFSET", "datetimeoffset", "Changes the time zone offset of a datetimeoffset value while preserving the UTC instant.", ["SWITCHOFFSET( datetimeoffset_expression, timezone_offset ) -> datetimeoffset"]),
        new FunctionInfo("TODATETIMEOFFSET", "datetimeoffset", "Transforms a datetime2 value into a datetimeoffset value.", ["TODATETIMEOFFSET( expression, timezone_offset ) -> datetimeoffset"]),
        new FunctionInfo("YEAR", "int", "Returns an integer representing the year of the specified date.", ["YEAR( date ) -> int"]),
        new FunctionInfo("MONTH", "int", "Returns an integer representing the month of the specified date.", ["MONTH( date ) -> int"]),
        new FunctionInfo("DAY", "int", "Returns an integer representing the day of the month of the specified date.", ["DAY( date ) -> int"]),
        new FunctionInfo("ISDATE", "int", "Returns 1 if the expression is a valid date, time, or datetime value; otherwise 0.", ["ISDATE( expression ) -> int"]),

        // String
        new FunctionInfo("CONCAT", "nvarchar", "Returns a string resulting from the concatenation of two or more values (NULL becomes empty string).", ["CONCAT( string_value1, string_value2 [, string_valueN ] ) -> varchar/nvarchar"]),
        new FunctionInfo("CONCAT_WS", "nvarchar", "Concatenates values with a separator, skipping NULL values.", ["CONCAT_WS( separator, argument1, argument2 [, argumentN ] ) -> varchar/nvarchar"]),
        new FunctionInfo("SUBSTRING", "nvarchar", "Returns part of a character, binary, text, or image expression (1-based start).", ["SUBSTRING( expression, start, length )"]),
        new FunctionInfo("LEFT", "nvarchar", "Returns the left part of a character string with the specified number of characters.", ["LEFT( character_expression, integer_expression )"]),
        new FunctionInfo("RIGHT", "nvarchar", "Returns the right part of a character string with the specified number of characters.", ["RIGHT( character_expression, integer_expression )"]),
        new FunctionInfo("LEN", "int/bigint", "Returns the number of characters of the specified string expression, excluding trailing spaces.", ["LEN( string_expression ) -> int/bigint"]),
        new FunctionInfo("DATALENGTH", "int/bigint", "Returns the number of bytes used to represent any expression.", ["DATALENGTH( expression ) -> int/bigint"]),
        new FunctionInfo("CHARINDEX", "int/bigint", "Searches an expression for another expression and returns its 1-based starting position.", ["CHARINDEX( expressionToFind, expressionToSearch [, start_location ] ) -> int/bigint"]),
        new FunctionInfo("PATINDEX", "int/bigint", "Returns the starting position of the first occurrence of a LIKE pattern in an expression.", ["PATINDEX( '%pattern%', expression ) -> int/bigint"]),
        new FunctionInfo("REPLACE", "nvarchar", "Replaces all occurrences of a specified string value with another string value.", ["REPLACE( string_expression, string_pattern, string_replacement )"]),
        new FunctionInfo("TRANSLATE", "nvarchar", "Returns the string provided as a first argument after translating characters.", ["TRANSLATE( inputString, characters, translations )"]),
        new FunctionInfo("STUFF", "nvarchar", "Deletes a specified length of characters and inserts another string at the start position.", ["STUFF( character_expression, start, length, replaceWith_expression )"]),
        new FunctionInfo("TRIM", "nvarchar", "Removes the space character or specified characters from the start and end of a string.", ["TRIM( [ [ LEADING | TRAILING | BOTH ] characters FROM ] string )"]),
        new FunctionInfo("LTRIM", "nvarchar", "Removes leading spaces or specified characters from a string.", ["LTRIM( character_expression [, characters ] )"]),
        new FunctionInfo("RTRIM", "nvarchar", "Removes trailing spaces or specified characters from a string.", ["RTRIM( character_expression [, characters ] )"]),
        new FunctionInfo("UPPER", "nvarchar", "Returns a character expression with lowercase character data converted to uppercase.", ["UPPER( character_expression )"]),
        new FunctionInfo("LOWER", "nvarchar", "Returns a character expression with uppercase character data converted to lowercase.", ["LOWER( character_expression )"]),
        new FunctionInfo("REVERSE", "nvarchar", "Returns the reverse order of a string value.", ["REVERSE( string_expression )"]),
        new FunctionInfo("REPLICATE", "nvarchar", "Repeats a string value a specified number of times.", ["REPLICATE( string_expression, integer_expression )"]),
        new FunctionInfo("SPACE", "varchar", "Returns a string of repeated spaces.", ["SPACE( integer_expression ) -> varchar"]),
        new FunctionInfo("STR", "varchar", "Returns character data converted from numeric data.", ["STR( float_expression [, length [, decimal ] ] ) -> varchar"]),
        new FunctionInfo("QUOTENAME", "nvarchar(258)", "Returns a Unicode string with the delimiters added to make the input a valid SQL Server delimited identifier.", ["QUOTENAME( 'character_string' [, 'quote_character' ] ) -> nvarchar(258)"]),
        new FunctionInfo("STRING_SPLIT", "table", "Table-valued function that splits a string into rows of substrings based on a separator.", ["STRING_SPLIT( string, separator [, enable_ordinal ] ) -> TABLE(value, ordinal)"]),
        new FunctionInfo("STRING_ESCAPE", "nvarchar", "Escapes special characters in texts and returns text with escaped characters.", ["STRING_ESCAPE( text, type ) -> nvarchar"]),
        new FunctionInfo("ASCII", "int", "Returns the ASCII code value of the leftmost character of a character expression.", ["ASCII( character_expression ) -> int"]),
        new FunctionInfo("UNICODE", "int", "Returns the Unicode integer value of the first character of the input expression.", ["UNICODE( 'ncharacter_expression' ) -> int"]),
        new FunctionInfo("CHAR", "char(1)", "Converts an int ASCII code to a character value.", ["CHAR( integer_expression ) -> char(1)"]),
        new FunctionInfo("NCHAR", "nchar(1)", "Returns the Unicode character with the specified integer code.", ["NCHAR( integer_expression ) -> nchar(1)"]),

        // JSON
        new FunctionInfo("JSON_VALUE", "nvarchar(4000)", "Extracts a scalar value from a JSON string.", ["JSON_VALUE( expression, path ) -> nvarchar(4000)"]),
        new FunctionInfo("JSON_QUERY", "nvarchar(max)", "Extracts an object or an array from a JSON string.", ["JSON_QUERY( expression [, path ] ) -> nvarchar(max)"]),
        new FunctionInfo("JSON_MODIFY", "nvarchar(max)", "Updates the value of a property in a JSON string and returns the updated JSON string.", ["JSON_MODIFY( expression, path, newValue ) -> nvarchar(max)"]),
        new FunctionInfo("JSON_PATH_EXISTS", "int", "Tests whether a specified SQL/JSON path exists in the input JSON string.", ["JSON_PATH_EXISTS( value_expression, sql_json_path ) -> int"]),
        new FunctionInfo("JSON_OBJECT", "nvarchar(max)", "Constructs JSON object text from zero or more expressions.", ["JSON_OBJECT( [ json_key_value [, ...n] ] ) -> nvarchar(max)"]),
        new FunctionInfo("JSON_ARRAY", "nvarchar(max)", "Constructs JSON array text from zero or more expressions.", ["JSON_ARRAY( [ json_array_value [, ...n] ] ) -> nvarchar(max)"]),
        new FunctionInfo("ISJSON", "int", "Tests whether a string contains valid JSON.", ["ISJSON( expression [, json_type_constraint ] ) -> int"]),
        new FunctionInfo("OPENJSON", "table", "Table-valued function that parses JSON text and returns objects and properties as rows and columns.", ["OPENJSON( jsonExpression [, path ] ) [ WITH ( colName type [ colPath ] [, ...n] ) ] -> TABLE"]),

        // Window / Ranking / Analytic
        new FunctionInfo("ROW_NUMBER", "bigint", "Numbers the output of a result set sequentially within each partition.", ["ROW_NUMBER() OVER ( [ PARTITION BY value_expression ] ORDER BY order_by_clause ) -> bigint"]),
        new FunctionInfo("RANK", "bigint", "Returns the rank of each row within the partition, with gaps for ties.", ["RANK() OVER ( [ PARTITION BY value_expression ] ORDER BY order_by_clause ) -> bigint"]),
        new FunctionInfo("DENSE_RANK", "bigint", "Returns the rank of each row within a result set partition, without any gaps in ranking.", ["DENSE_RANK() OVER ( [ PARTITION BY value_expression ] ORDER BY order_by_clause ) -> bigint"]),
        new FunctionInfo("NTILE", "bigint", "Distributes the rows in an ordered partition into a specified number of groups.", ["NTILE( integer_expression ) OVER ( [ PARTITION BY value_expression ] ORDER BY order_by_clause ) -> bigint"]),
        new FunctionInfo("LAG", "any", "Accesses data from a previous row in the same result set without a self-join.", ["LAG( scalar_expression [, offset [, default ] ] ) OVER ( [ PARTITION BY ... ] ORDER BY ... )"]),
        new FunctionInfo("LEAD", "any", "Accesses data from a subsequent row in the same result set without a self-join.", ["LEAD( scalar_expression [, offset [, default ] ] ) OVER ( [ PARTITION BY ... ] ORDER BY ... )"]),
        new FunctionInfo("FIRST_VALUE", "any", "Returns the first value in an ordered set of values.", ["FIRST_VALUE( scalar_expression ) OVER ( [ PARTITION BY ... ] ORDER BY ... )"]),
        new FunctionInfo("LAST_VALUE", "any", "Returns the last value in an ordered set of values.", ["LAST_VALUE( scalar_expression ) OVER ( [ PARTITION BY ... ] ORDER BY ... )"]),
        new FunctionInfo("PERCENT_RANK", "float", "Calculates the relative rank of a row within a group of rows.", ["PERCENT_RANK() OVER ( [ PARTITION BY ... ] ORDER BY ... ) -> float"]),
        new FunctionInfo("CUME_DIST", "float", "Calculates the cumulative distribution of a value in a group of values.", ["CUME_DIST() OVER ( [ PARTITION BY ... ] ORDER BY ... ) -> float"]),

        // Math
        new FunctionInfo("ABS", "numeric", "Returns the absolute (positive) value of the specified numeric expression.", ["ABS( numeric_expression )"]),
        new FunctionInfo("CEILING", "numeric", "Returns the smallest integer greater than, or equal to, the specified numeric expression.", ["CEILING( numeric_expression )"]),
        new FunctionInfo("FLOOR", "numeric", "Returns the largest integer less than or equal to the specified numeric expression.", ["FLOOR( numeric_expression )"]),
        new FunctionInfo("ROUND", "numeric", "Returns a numeric value, rounded to the specified length or precision.", ["ROUND( numeric_expression, length [, function ] )"]),
        new FunctionInfo("POWER", "float", "Returns the value of the specified expression to the specified power.", ["POWER( float_expression, y )"]),
        new FunctionInfo("SQRT", "float", "Returns the square root of the specified float value.", ["SQRT( float_expression ) -> float"]),
        new FunctionInfo("SIGN", "numeric", "Returns the positive (+1), zero (0), or negative (-1) sign of the specified expression.", ["SIGN( numeric_expression )"]),
        new FunctionInfo("RAND", "float", "Returns a pseudo-random float value from 0 through 1, exclusive.", ["RAND( [ seed ] ) -> float"]),
        new FunctionInfo("ISNUMERIC", "int", "Determines whether an expression is a valid numeric type.", ["ISNUMERIC( expression ) -> int"]),

        // System, Metadata & Identity
        new FunctionInfo("SCOPE_IDENTITY", "numeric(38,0)", "Returns the last identity value inserted into an identity column in the same scope.", ["SCOPE_IDENTITY() -> numeric(38,0)"]),
        new FunctionInfo("IDENT_CURRENT", "numeric(38,0)", "Returns the last identity value generated for a specified table or view in any session.", ["IDENT_CURRENT( 'table_or_view' ) -> numeric(38,0)"]),
        new FunctionInfo("NEWID", "uniqueidentifier", "Creates a unique value of type uniqueidentifier (UUID v4).", ["NEWID() -> uniqueidentifier"]),
        new FunctionInfo("NEWSEQUENTIALID", "uniqueidentifier", "Creates a GUID greater than any previously generated GUID on this computer since Windows started.", ["NEWSEQUENTIALID() -> uniqueidentifier"]),
        new FunctionInfo("DB_NAME", "nvarchar(128)", "Returns the database name for the specified database ID or the current database.", ["DB_NAME( [ database_id ] ) -> nvarchar(128)"]),
        new FunctionInfo("DB_ID", "int", "Returns the database identification (ID) number of a specified database.", ["DB_ID( [ 'database_name' ] ) -> int"]),
        new FunctionInfo("OBJECT_ID", "int", "Returns the database object identification number of a schema-scoped object.", ["OBJECT_ID( 'object_name' [, 'object_type' ] ) -> int"]),
        new FunctionInfo("OBJECT_NAME", "sysname", "Returns the database object name for schema-scoped objects.", ["OBJECT_NAME( object_id [, database_id ] ) -> sysname"]),
        new FunctionInfo("OBJECT_SCHEMA_NAME", "sysname", "Returns the database schema name for schema-scoped objects.", ["OBJECT_SCHEMA_NAME( object_id [, database_id ] ) -> sysname"]),
        new FunctionInfo("SCHEMA_NAME", "sysname", "Returns the schema name associated with a schema ID.", ["SCHEMA_NAME( [ schema_id ] ) -> sysname"]),
        new FunctionInfo("SCHEMA_ID", "int", "Returns the schema ID associated with a schema name.", ["SCHEMA_ID( [ schema_name ] ) -> int"]),
        new FunctionInfo("COL_LENGTH", "smallint", "Returns the defined length of a column, in bytes.", ["COL_LENGTH( 'table', 'column' ) -> smallint"]),
        new FunctionInfo("COL_NAME", "sysname", "Returns the name of a table column, based on table ID and column ID.", ["COL_NAME( table_id, column_id ) -> sysname"]),
        new FunctionInfo("TYPE_NAME", "sysname", "Returns the unqualified type name of a specified type ID.", ["TYPE_NAME( type_id ) -> sysname"]),
        new FunctionInfo("SUSER_SNAME", "nvarchar(128)", "Returns the login name associated with a security identification number (SID).", ["SUSER_SNAME( [ server_user_sid ] ) -> nvarchar(128)"]),
        new FunctionInfo("USER_NAME", "nvarchar(128)", "Returns a database user name from a specified identification number.", ["USER_NAME( [ id ] ) -> nvarchar(128)"]),
        new FunctionInfo("ORIGINAL_LOGIN", "sysname", "Returns the name of the login that connected to the instance of SQL Server.", ["ORIGINAL_LOGIN() -> sysname"]),
        new FunctionInfo("APP_NAME", "nvarchar(128)", "Returns the application name for the current session.", ["APP_NAME() -> nvarchar(128)"]),
        new FunctionInfo("HOST_NAME", "nvarchar(128)", "Returns the workstation name.", ["HOST_NAME() -> nvarchar(128)"]),
        new FunctionInfo("SERVERPROPERTY", "sql_variant", "Returns property information about the server instance.", ["SERVERPROPERTY( 'propertyname' ) -> sql_variant"]),
        new FunctionInfo("DATABASEPROPERTYEX", "sql_variant", "Returns the current setting of the specified database option or property.", ["DATABASEPROPERTYEX( 'database', 'property' ) -> sql_variant"]),
        new FunctionInfo("SESSION_CONTEXT", "sql_variant", "Returns the value of the specified key in the current session context.", ["SESSION_CONTEXT( N'key' ) -> sql_variant"]),
        new FunctionInfo("HASHBYTES", "varbinary(8000)", "Returns the SHA2_256 or SHA2_512 hash of the input in SQL Server.", ["HASHBYTES( '<algorithm>', @input ) -> varbinary(8000)"]),
        new FunctionInfo("COMPRESS", "varbinary(max)", "Compresses the input expression using the GZIP algorithm.", ["COMPRESS( expression ) -> varbinary(max)"]),
        new FunctionInfo("DECOMPRESS", "varbinary(max)", "Decompresses an input expression value using the GZIP algorithm.", ["DECOMPRESS( expression ) -> varbinary(max)"]),
        new FunctionInfo("GENERATE_SERIES", "table", "Relational operator that generates a series of numbers within a given interval (SQL Server 2022+).", ["GENERATE_SERIES( start, stop [, step ] ) -> TABLE(value)"]),

        // Error handling
        new FunctionInfo("ERROR_MESSAGE", "nvarchar(4000)", "Returns the message text of the error that caused the CATCH block to be run.", ["ERROR_MESSAGE() -> nvarchar(4000)"]),
        new FunctionInfo("ERROR_NUMBER", "int", "Returns the error number of the error that caused the CATCH block to be run.", ["ERROR_NUMBER() -> int"]),
        new FunctionInfo("ERROR_SEVERITY", "int", "Returns the severity of the error that caused the CATCH block to be run.", ["ERROR_SEVERITY() -> int"]),
        new FunctionInfo("ERROR_STATE", "int", "Returns the state number of the error that caused the CATCH block to be run.", ["ERROR_STATE() -> int"]),
        new FunctionInfo("ERROR_LINE", "int", "Returns the line number at which an error occurred that caused the CATCH block to be run.", ["ERROR_LINE() -> int"]),
        new FunctionInfo("ERROR_PROCEDURE", "nvarchar(128)", "Returns the name of the stored procedure or trigger where an error occurred.", ["ERROR_PROCEDURE() -> nvarchar(128)"]),
        new FunctionInfo("XACT_STATE", "smallint", "Reports the user transaction state of a current running request (1 = committable, 0 = none, -1 = uncommittable).", ["XACT_STATE() -> smallint"])
    ];

    internal static readonly IReadOnlyDictionary<string, FunctionInfo> FunctionMap =
        BuiltInFunctions.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);

    internal static string Bracket(string name) =>
        "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";

    internal static string FormatObjectPath(string? database, string? schema, string name)
    {
        var sb = new StringBuilder(64);
        if (!string.IsNullOrEmpty(database))
        {
            sb.Append(Bracket(database)).Append('.');
            sb.Append(!string.IsNullOrEmpty(schema) ? Bracket(schema) : "[dbo]").Append('.');
        }
        else if (!string.IsNullOrEmpty(schema))
        {
            sb.Append(Bracket(schema)).Append('.');
        }
        sb.Append(Bracket(name));
        return sb.ToString();
    }

    internal static string Unquote(string value)
    {
        if (value.Length >= 2 && value[0] == '[' && value[^1] == ']')
            return value[1..^1].Replace("]]", "]", StringComparison.Ordinal);
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            return value[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal);
        if (value.Length >= 1 && value[0] == '[')
            return value[1..].Replace("]]", "]", StringComparison.Ordinal);
        if (value.Length >= 1 && value[0] == '"')
            return value[1..].Replace("\"\"", "\"", StringComparison.Ordinal);
        return value;
    }

    internal static bool NeedsQuoting(string name)
    {
        if (string.IsNullOrEmpty(name)) return true;
        if (ReservedKeywords.Contains(name)) return true;
        var first = name[0];
        if (!(char.IsLetter(first) || first is '_' or '@' or '#')) return true;
        for (var i = 1; i < name.Length; i++)
        {
            var c = name[i];
            if (!(char.IsLetterOrDigit(c) || c is '_' or '@' or '#' or '$')) return true;
        }
        return false;
    }

    internal static string EscapeMarkdown(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var sb = new StringBuilder(text.Length + 8);
        foreach (var ch in text)
        {
            if (ch is '\r' or '\n') { sb.Append(' '); continue; }
            if (ch is '\\' or '`' or '*' or '_' or '{' or '}' or '[' or ']' or '(' or ')' or '#' or '+' or '-' or '.' or '!' or '|' or '<' or '>' or '~')
                sb.Append('\\');
            sb.Append(ch);
        }
        return sb.ToString();
    }
}

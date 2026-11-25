# GoogleSQL editor

<!-- Generated from src/shared/googlesql/catalog.ts. Regenerate with: npx vitest run tests/googlesql-catalog.test.ts -u -->

A query on a BigQuery connection is edited as GoogleSQL; a query on SQL Server stays Transact-SQL. Both are the same kind
of tab: only its language, its colours and its signature help differ.

## Language

- **Follows the connection.** A query opened on a BigQuery connection is GoogleSQL. Changing a tab's connection to
  one of the other engine switches its language and clears its error markers, and a notification says so, since the
  SQL is unlikely to run as is (an empty query switches silently). Disconnecting keeps the language.
- **Caption.** The tab's icon is named "GoogleSQL" or "Transact-SQL".
- **Kept.** Hot exit, AutoRecover and Reopen Closed Query keep a query's engine, so a BigQuery query reopens as GoogleSQL
  without its connection. Nothing is checked or sent to Google when a tab switches or reopens.
- **Highlighting.** Backtick identifiers with dots and dashes (`` `my-proj.dataset.table` ``), `r`, `b`, `rb` and `br`
  string prefixes, triple-quoted strings, `--`, `#` and `/* */` comments, `@param` and `@@system_variable`,
  `STRUCT<…>`, `ARRAY<…>` and `RANGE<…>` types, and the keywords below. Function names are coloured where they are called,
  since many (`DATE`, `LEFT`, `FORMAT`) are common column names too; a name after a dot is always a name, except a
  namespaced function's (`NET.HOST(`, `SAFE.NET.HOST(`). The colours
  are the SQL syntax colours of the theme.
- **Brackets and quotes.** `(` and `[` pair and match; quotes and backticks close themselves outside strings and
  comments. Toggle Comment uses `--`.
- **Signature help.** Typing `(` or `,` in a call to a function below shows its signatures and the parameter the caret
  is in; **Ctrl+Shift+Space** (**⇧⌘Space** on macOS) shows it on demand, and **Up** and **Down** step through a
  function's signatures. A `SAFE.` prefix shows the function it prefixes. Nothing shows inside a string or a comment, in
  a parenthesis no function name precedes, or in a document over 250,000 characters.

Completion and hover come from the connection's Search Objects index, with the aliases and `WITH` names in scope
([language-services.md](language-services.md#completion-from-the-index)); a dry run marks errors as you pause typing
([bigquery.md](bigquery.md#cost)).

## Keywords

Reserved keywords (96): `ALL`, `AND`, `ANY`, `ARRAY`, `AS`, `ASC`, `ASSERT_ROWS_MODIFIED`, `AT`, `BETWEEN`, `BY`, `CASE`, `CAST`, `COLLATE`, `CONTAINS`, `CREATE`, `CROSS`, `CUBE`, `CURRENT`, `DEFAULT`, `DEFINE`, `DESC`, `DISTINCT`, `ELSE`, `END`, `ENUM`, `ESCAPE`, `EXCEPT`, `EXCLUDE`, `EXISTS`, `EXTRACT`, `FALSE`, `FETCH`, `FOLLOWING`, `FOR`, `FROM`, `FULL`, `GROUP`, `GROUPING`, `GROUPS`, `HASH`, `HAVING`, `IF`, `IGNORE`, `IN`, `INNER`, `INTERSECT`, `INTERVAL`, `INTO`, `IS`, `JOIN`, `LATERAL`, `LEFT`, `LIKE`, `LIMIT`, `LOOKUP`, `MERGE`, `NATURAL`, `NEW`, `NO`, `NOT`, `NULL`, `NULLS`, `OF`, `ON`, `OR`, `ORDER`, `OUTER`, `OVER`, `PARTITION`, `PRECEDING`, `PROTO`, `QUALIFY`, `RANGE`, `RECURSIVE`, `RESPECT`, `RIGHT`, `ROLLUP`, `ROWS`, `SELECT`, `SET`, `SOME`, `STRUCT`, `TABLESAMPLE`, `THEN`, `TO`, `TREAT`, `TRUE`, `UNBOUNDED`, `UNION`, `UNNEST`, `USING`, `WHEN`, `WHERE`, `WINDOW`, `WITH`, `WITHIN`.

Other keywords (110): `ABORT`, `ACCESS`, `ACTION`, `ADD`, `AFTER`, `AGGREGATE`, `ALTER`, `ANALYZE`, `ASSERT`, `BEGIN`, `BREAK`, `CALL`, `CASCADE`, `CHECK`, `CLONE`, `CLUSTER`, `COLUMN`, `COLUMNS`, `COMMIT`, `CONNECTION`, `CONSTANT`, `CONSTRAINT`, `CONTINUE`, `COPY`, `CYCLE`, `DATA`, `DECLARE`, `DELETE`, `DESCRIBE`, `DETERMINISTIC`, `DO`, `DROP`, `ELSEIF`, `ENFORCED`, `EXCEPTION`, `EXECUTE`, `EXPLAIN`, `EXPORT`, `EXTERNAL`, `FILES`, `FILTER`, `FIRST`, `FOREIGN`, `FUNCTION`, `GRANT`, `IMMEDIATE`, `INDEX`, `INOUT`, `INSERT`, `ITERATE`, `KEY`, `LANGUAGE`, `LAST`, `LEAVE`, `LOAD`, `LOOP`, `MATCHED`, `MATERIALIZED`, `MESSAGE`, `MODEL`, `OFFSET`, `OPTIONS`, `ORDINAL`, `OUT`, `OVERWRITE`, `PERCENT`, `PIVOT`, `POLICY`, `PRIMARY`, `PRIVILEGES`, `PROCEDURE`, `RAISE`, `REFERENCES`, `RENAME`, `REPEAT`, `REPLACE`, `REPLICA`, `RESERVATION`, `RESTRICT`, `RETURN`, `RETURNS`, `REVOKE`, `ROLLBACK`, `ROW`, `SAFE`, `SAFE_OFFSET`, `SAFE_ORDINAL`, `SCHEMA`, `SEARCH`, `SECURITY`, `SNAPSHOT`, `SOURCE`, `SQL`, `SYSTEM`, `SYSTEM_TIME`, `TABLE`, `TARGET`, `TEMP`, `TEMPORARY`, `TRANSACTION`, `TRUNCATE`, `UNDROP`, `UNPIVOT`, `UNTIL`, `UPDATE`, `VALUE`, `VALUES`, `VIEW`, `WHILE`, `ZONE`.

Types (22): `BIGDECIMAL`, `BIGINT`, `BIGNUMERIC`, `BOOL`, `BOOLEAN`, `BYTEINT`, `BYTES`, `DATE`, `DATETIME`, `DECIMAL`, `FLOAT64`, `GEOGRAPHY`, `INT`, `INT64`, `INTEGER`, `JSON`, `NUMERIC`, `SMALLINT`, `STRING`, `TIME`, `TIMESTAMP`, `TINYINT`.

Functions callable without parentheses: `CURRENT_DATE`, `CURRENT_DATETIME`, `CURRENT_TIME`, `CURRENT_TIMESTAMP`.

## Functions

335 functions, from Google's public GoogleSQL reference for BigQuery, with Varia's own one-line
summaries. An optional parameter is in brackets; `...` repeats the parameter before it.

### Aggregate

| Function | Signatures | Summary |
| --- | --- | --- |
| `ANY_VALUE` | `ANY_VALUE(expression [HAVING {MAX \| MIN} expression2]) → type of expression` | Returns the expression's value for some row of the group. |
| `ARRAY_AGG` | `ARRAY_AGG([DISTINCT] expression [{IGNORE \| RESPECT} NULLS] [ORDER BY key] [LIMIT n]) → ARRAY` | Collects the values of a group into an array. |
| `ARRAY_CONCAT_AGG` | `ARRAY_CONCAT_AGG(expression [ORDER BY key] [LIMIT n]) → ARRAY` | Concatenates the arrays of a group into one array. |
| `AVG` | `AVG([DISTINCT] expression) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns the average of the non-NULL values. |
| `BIT_AND` | `BIT_AND([DISTINCT] expression) → INT64` | Returns the bitwise AND of the values. |
| `BIT_OR` | `BIT_OR([DISTINCT] expression) → INT64` | Returns the bitwise OR of the values. |
| `BIT_XOR` | `BIT_XOR([DISTINCT] expression) → INT64` | Returns the bitwise XOR of the values. |
| `COUNT` | `COUNT(*) → INT64`<br>`COUNT([DISTINCT] expression) → INT64` | Counts the rows, or the non-NULL values of an expression. |
| `COUNTIF` | `COUNTIF([DISTINCT] expression) → INT64` | Counts the rows for which the condition is TRUE. |
| `GROUPING` | `GROUPING(groupable_value) → INT64` | Tells whether a GROUP BY column is aggregated (1) in this row of a ROLLUP, CUBE or GROUPING SETS. |
| `LOGICAL_AND` | `LOGICAL_AND(expression) → BOOL` | Returns TRUE when every non-NULL value is TRUE. |
| `LOGICAL_OR` | `LOGICAL_OR(expression) → BOOL` | Returns TRUE when any non-NULL value is TRUE. |
| `MAX` | `MAX(expression) → type of expression` | Returns the largest non-NULL value. |
| `MAX_BY` | `MAX_BY(x, y) → type of x` | Returns x from the row with the largest y. |
| `MIN` | `MIN(expression) → type of expression` | Returns the smallest non-NULL value. |
| `MIN_BY` | `MIN_BY(x, y) → type of x` | Returns x from the row with the smallest y. |
| `STRING_AGG` | `STRING_AGG([DISTINCT] expression, [delimiter] [ORDER BY key] [LIMIT n]) → STRING or BYTES` | Concatenates the non-NULL values, with an optional delimiter. |
| `SUM` | `SUM([DISTINCT] expression) → INT64, NUMERIC, BIGNUMERIC or FLOAT64` | Returns the sum of the non-NULL values. |

### Approximate aggregate

| Function | Signatures | Summary |
| --- | --- | --- |
| `APPROX_COUNT_DISTINCT` | `APPROX_COUNT_DISTINCT(expression) → INT64` | Estimates the number of distinct values. |
| `APPROX_QUANTILES` | `APPROX_QUANTILES([DISTINCT] expression, number [{IGNORE \| RESPECT} NULLS]) → ARRAY` | Estimates the quantile boundaries of the values. |
| `APPROX_TOP_COUNT` | `APPROX_TOP_COUNT(expression, number) → ARRAY<STRUCT<value, count INT64>>` | Estimates the most frequent values and their counts. |
| `APPROX_TOP_SUM` | `APPROX_TOP_SUM(expression, weight, number) → ARRAY<STRUCT<value, sum>>` | Estimates the values with the largest sums of a weight. |

### Array

| Function | Signatures | Summary |
| --- | --- | --- |
| `ARRAY` | `ARRAY(subquery) → ARRAY` | Makes an array of the rows a subquery returns. |
| `ARRAY_CONCAT` | `ARRAY_CONCAT(array_expression, ...) → ARRAY` | Concatenates arrays of the same element type. |
| `ARRAY_FIRST` | `ARRAY_FIRST(array_expression) → type of element` | Returns an array's first element; an error for an empty array. |
| `ARRAY_LAST` | `ARRAY_LAST(array_expression) → type of element` | Returns an array's last element; an error for an empty array. |
| `ARRAY_LENGTH` | `ARRAY_LENGTH(array_expression) → INT64` | Returns the number of elements in an array. |
| `ARRAY_REVERSE` | `ARRAY_REVERSE(value) → ARRAY` | Returns an array's elements in reverse order. |
| `ARRAY_SLICE` | `ARRAY_SLICE(array_to_slice, start_offset, end_offset) → ARRAY` | Returns the elements between two offsets, which may count from the end when negative. |
| `ARRAY_TO_STRING` | `ARRAY_TO_STRING(array_expression, delimiter, [null_text]) → STRING or BYTES` | Joins an array of STRING or BYTES values with a delimiter. |
| `GENERATE_ARRAY` | `GENERATE_ARRAY(start_expression, end_expression, [step_expression]) → ARRAY` | Makes an array of numbers from start to end by a step. |
| `GENERATE_DATE_ARRAY` | `GENERATE_DATE_ARRAY(start_date, end_date, [INTERVAL int64_expr date_part]) → ARRAY<DATE>` | Makes an array of dates from start to end by an interval. |
| `GENERATE_TIMESTAMP_ARRAY` | `GENERATE_TIMESTAMP_ARRAY(start_timestamp, end_timestamp, INTERVAL step_expression date_part) → ARRAY<TIMESTAMP>` | Makes an array of timestamps from start to end by an interval. |

### Bit

| Function | Signatures | Summary |
| --- | --- | --- |
| `BIT_COUNT` | `BIT_COUNT(expression) → INT64` | Counts the bits set in an INT64 or BYTES value. |

### Conditional expressions

| Function | Signatures | Summary |
| --- | --- | --- |
| `COALESCE` | `COALESCE(expression, ...) → supertype of the arguments` | Returns the first non-NULL argument. |
| `IF` | `IF(expr, true_result, else_result) → supertype of the results` | Returns one result when the condition is TRUE and another otherwise. |
| `IFNULL` | `IFNULL(expr, null_result) → supertype of the arguments` | Returns the expression, or the replacement when it is NULL. |
| `NULLIF` | `NULLIF(expr, expr_to_match) → supertype of the arguments` | Returns NULL when the two arguments are equal, and the first otherwise. |
| `NULLIFZERO` | `NULLIFZERO(expr) → type of expr` | Returns NULL for zero, and the value otherwise. |
| `ZEROIFNULL` | `ZEROIFNULL(expr) → type of expr` | Returns zero for NULL, and the value otherwise. |

### Conversion

| Function | Signatures | Summary |
| --- | --- | --- |
| `CAST` | `CAST(expression AS typename [FORMAT format_string_expression]) → typename` | Converts a value to another type; an error when it cannot. |
| `PARSE_BIGNUMERIC` | `PARSE_BIGNUMERIC(string_expression) → BIGNUMERIC` | Reads a STRING as a BIGNUMERIC. |
| `PARSE_NUMERIC` | `PARSE_NUMERIC(string_expression) → NUMERIC` | Reads a STRING as a NUMERIC. |
| `SAFE_CAST` | `SAFE_CAST(expression AS typename [FORMAT format_string_expression]) → typename` | Converts a value to another type, or returns NULL when it cannot. |

### Date

| Function | Signatures | Summary |
| --- | --- | --- |
| `CURRENT_DATE` | `CURRENT_DATE([time_zone_expression]) → DATE` | Returns today's date, in the default or the given time zone. |
| `DATE` | `DATE(year, month, day) → DATE`<br>`DATE(timestamp_expression, [time_zone_expression]) → DATE`<br>`DATE(datetime_expression) → DATE` | Makes a DATE from its parts, or from a TIMESTAMP or DATETIME. |
| `DATE_ADD` | `DATE_ADD(date_expression, INTERVAL int64_expression date_part) → DATE` | Adds an interval to a DATE. |
| `DATE_BUCKET` | `DATE_BUCKET(date_in_bucket, bucket_width, [bucket_origin_date]) → DATE` | Returns the start of the bucket of a given width that holds a date. |
| `DATE_DIFF` | `DATE_DIFF(end_date, start_date, granularity) → INT64` | Counts the whole date parts between two dates. |
| `DATE_FROM_UNIX_DATE` | `DATE_FROM_UNIX_DATE(int64_expression) → DATE` | Makes a DATE from a number of days since 1970-01-01. |
| `DATE_SUB` | `DATE_SUB(date_expression, INTERVAL int64_expression date_part) → DATE` | Subtracts an interval from a DATE. |
| `DATE_TRUNC` | `DATE_TRUNC(date_value, date_granularity) → DATE` | Truncates a DATE to a granularity. |
| `EXTRACT` | `EXTRACT(part FROM expression [AT TIME ZONE time_zone]) → INT64, DATE or TIME` | Returns one part of a date, time, timestamp or interval. |
| `FORMAT_DATE` | `FORMAT_DATE(format_string, date_expr) → STRING` | Formats a DATE with a format string. |
| `LAST_DAY` | `LAST_DAY(date_expression, [date_part]) → DATE` | Returns the last day of the date part that holds a date. |
| `PARSE_DATE` | `PARSE_DATE(format_string, date_string) → DATE` | Reads a STRING as a DATE with a format string. |
| `UNIX_DATE` | `UNIX_DATE(date_expression) → INT64` | Returns the number of days since 1970-01-01. |

### Datetime

| Function | Signatures | Summary |
| --- | --- | --- |
| `CURRENT_DATETIME` | `CURRENT_DATETIME([time_zone_expression]) → DATETIME` | Returns the current date and time, in the default or the given time zone. |
| `DATETIME` | `DATETIME(year, month, day, hour, minute, second) → DATETIME`<br>`DATETIME(date_expression, [time_expression]) → DATETIME`<br>`DATETIME(timestamp_expression, [time_zone]) → DATETIME` | Makes a DATETIME from its parts, a DATE and a TIME, or a TIMESTAMP. |
| `DATETIME_ADD` | `DATETIME_ADD(datetime_expression, INTERVAL int64_expression part) → DATETIME` | Adds an interval to a DATETIME. |
| `DATETIME_BUCKET` | `DATETIME_BUCKET(datetime_in_bucket, bucket_width, [bucket_origin_datetime]) → DATETIME` | Returns the start of the bucket of a given width that holds a datetime. |
| `DATETIME_DIFF` | `DATETIME_DIFF(end_datetime, start_datetime, granularity) → INT64` | Counts the whole parts between two DATETIME values. |
| `DATETIME_SUB` | `DATETIME_SUB(datetime_expression, INTERVAL int64_expression part) → DATETIME` | Subtracts an interval from a DATETIME. |
| `DATETIME_TRUNC` | `DATETIME_TRUNC(datetime_value, datetime_granularity) → DATETIME` | Truncates a DATETIME to a granularity. |
| `FORMAT_DATETIME` | `FORMAT_DATETIME(format_string, datetime_expr) → STRING` | Formats a DATETIME with a format string. |
| `PARSE_DATETIME` | `PARSE_DATETIME(format_string, datetime_string) → DATETIME` | Reads a STRING as a DATETIME with a format string. |

### Time

| Function | Signatures | Summary |
| --- | --- | --- |
| `CURRENT_TIME` | `CURRENT_TIME([time_zone]) → TIME` | Returns the current time, in the default or the given time zone. |
| `FORMAT_TIME` | `FORMAT_TIME(format_string, time_expr) → STRING` | Formats a TIME with a format string. |
| `PARSE_TIME` | `PARSE_TIME(format_string, time_string) → TIME` | Reads a STRING as a TIME with a format string. |
| `TIME` | `TIME(hour, minute, second) → TIME`<br>`TIME(timestamp, [time_zone]) → TIME`<br>`TIME(datetime) → TIME` | Makes a TIME from its parts, a TIMESTAMP or a DATETIME. |
| `TIME_ADD` | `TIME_ADD(time_expression, INTERVAL int64_expression part) → TIME` | Adds an interval to a TIME. |
| `TIME_DIFF` | `TIME_DIFF(end_time, start_time, granularity) → INT64` | Counts the whole parts between two TIME values. |
| `TIME_SUB` | `TIME_SUB(time_expression, INTERVAL int64_expression part) → TIME` | Subtracts an interval from a TIME. |
| `TIME_TRUNC` | `TIME_TRUNC(time_value, time_granularity) → TIME` | Truncates a TIME to a granularity. |

### Timestamp

| Function | Signatures | Summary |
| --- | --- | --- |
| `CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP() → TIMESTAMP` | Returns the current time as a TIMESTAMP. |
| `FORMAT_TIMESTAMP` | `FORMAT_TIMESTAMP(format_string, timestamp_expr, [time_zone]) → STRING` | Formats a TIMESTAMP with a format string, in an optional time zone. |
| `PARSE_TIMESTAMP` | `PARSE_TIMESTAMP(format_string, timestamp_string, [time_zone]) → TIMESTAMP` | Reads a STRING as a TIMESTAMP with a format string. |
| `TIMESTAMP` | `TIMESTAMP(string_expression, [time_zone]) → TIMESTAMP`<br>`TIMESTAMP(date_expression, [time_zone]) → TIMESTAMP`<br>`TIMESTAMP(datetime_expression, [time_zone]) → TIMESTAMP` | Makes a TIMESTAMP from a STRING, DATE or DATETIME, in an optional time zone. |
| `TIMESTAMP_ADD` | `TIMESTAMP_ADD(timestamp_expression, INTERVAL int64_expression date_part) → TIMESTAMP` | Adds an interval to a TIMESTAMP. |
| `TIMESTAMP_BUCKET` | `TIMESTAMP_BUCKET(timestamp_in_bucket, bucket_width, [bucket_origin_timestamp]) → TIMESTAMP` | Returns the start of the bucket of a given width that holds a timestamp. |
| `TIMESTAMP_DIFF` | `TIMESTAMP_DIFF(end_timestamp, start_timestamp, granularity) → INT64` | Counts the whole parts between two TIMESTAMP values. |
| `TIMESTAMP_MICROS` | `TIMESTAMP_MICROS(int64_expression) → TIMESTAMP` | Makes a TIMESTAMP from microseconds since 1970-01-01 00:00:00 UTC. |
| `TIMESTAMP_MILLIS` | `TIMESTAMP_MILLIS(int64_expression) → TIMESTAMP` | Makes a TIMESTAMP from milliseconds since 1970-01-01 00:00:00 UTC. |
| `TIMESTAMP_SECONDS` | `TIMESTAMP_SECONDS(int64_expression) → TIMESTAMP` | Makes a TIMESTAMP from seconds since 1970-01-01 00:00:00 UTC. |
| `TIMESTAMP_SUB` | `TIMESTAMP_SUB(timestamp_expression, INTERVAL int64_expression date_part) → TIMESTAMP` | Subtracts an interval from a TIMESTAMP. |
| `TIMESTAMP_TRUNC` | `TIMESTAMP_TRUNC(timestamp_value, timestamp_granularity, [time_zone]) → TIMESTAMP` | Truncates a TIMESTAMP to a granularity, in an optional time zone. |
| `UNIX_MICROS` | `UNIX_MICROS(timestamp_expression) → INT64` | Returns microseconds since 1970-01-01 00:00:00 UTC. |
| `UNIX_MILLIS` | `UNIX_MILLIS(timestamp_expression) → INT64` | Returns milliseconds since 1970-01-01 00:00:00 UTC. |
| `UNIX_SECONDS` | `UNIX_SECONDS(timestamp_expression) → INT64` | Returns seconds since 1970-01-01 00:00:00 UTC. |

### Interval

| Function | Signatures | Summary |
| --- | --- | --- |
| `JUSTIFY_DAYS` | `JUSTIFY_DAYS(interval_expression) → INTERVAL` | Moves whole 30-day periods of an interval into months. |
| `JUSTIFY_HOURS` | `JUSTIFY_HOURS(interval_expression) → INTERVAL` | Moves whole 24-hour periods of an interval into days. |
| `JUSTIFY_INTERVAL` | `JUSTIFY_INTERVAL(interval_expression) → INTERVAL` | Applies JUSTIFY_HOURS and then JUSTIFY_DAYS. |
| `MAKE_INTERVAL` | `MAKE_INTERVAL([year], [month], [day], [hour], [minute], [second]) → INTERVAL` | Makes an INTERVAL from its parts. |

### Debugging

| Function | Signatures | Summary |
| --- | --- | --- |
| `ERROR` | `ERROR(error_message) → none` | Stops the query with the given error message. |

### AEAD encryption

| Function | Signatures | Summary |
| --- | --- | --- |
| `AEAD.DECRYPT_BYTES` | `AEAD.DECRYPT_BYTES(keyset, ciphertext, additional_data) → BYTES` | Decrypts ciphertext with a keyset and the additional data it was encrypted with. |
| `AEAD.DECRYPT_STRING` | `AEAD.DECRYPT_STRING(keyset, ciphertext, additional_data) → STRING` | Decrypts ciphertext to a STRING with a keyset and its additional data. |
| `AEAD.ENCRYPT` | `AEAD.ENCRYPT(keyset, plaintext, additional_data) → BYTES` | Encrypts plaintext with the keyset's primary key and additional data. |
| `DETERMINISTIC_DECRYPT_BYTES` | `DETERMINISTIC_DECRYPT_BYTES(keyset, ciphertext, additional_data) → BYTES` | Decrypts deterministically encrypted ciphertext. |
| `DETERMINISTIC_DECRYPT_STRING` | `DETERMINISTIC_DECRYPT_STRING(keyset, ciphertext, additional_data) → STRING` | Decrypts deterministically encrypted ciphertext to a STRING. |
| `DETERMINISTIC_ENCRYPT` | `DETERMINISTIC_ENCRYPT(keyset, plaintext, additional_data) → BYTES` | Encrypts plaintext so that equal inputs give equal ciphertext. |
| `KEYS.KEYSET_FROM_JSON` | `KEYS.KEYSET_FROM_JSON(json_keyset) → BYTES` | Reads a keyset from its JSON form. |
| `KEYS.KEYSET_LENGTH` | `KEYS.KEYSET_LENGTH(keyset) → INT64` | Returns the number of keys in a keyset. |
| `KEYS.KEYSET_TO_JSON` | `KEYS.KEYSET_TO_JSON(keyset) → STRING` | Writes a keyset as JSON. |
| `KEYS.NEW_KEYSET` | `KEYS.NEW_KEYSET(key_type) → BYTES` | Makes a keyset with one new key of the given type. |
| `KEYS.ROTATE_KEYSET` | `KEYS.ROTATE_KEYSET(keyset, key_type) → BYTES` | Adds a new primary key of the given type to a keyset. |

### Geography

| Function | Signatures | Summary |
| --- | --- | --- |
| `ST_AREA` | `ST_AREA(geography_expression, [use_spheroid]) → FLOAT64` | Returns the area of a geography's polygons, in square meters. |
| `ST_ASBINARY` | `ST_ASBINARY(geography_expression) → BYTES` | Returns a geography as WKB. |
| `ST_ASGEOJSON` | `ST_ASGEOJSON(geography_expression) → STRING` | Returns a geography as GeoJSON. |
| `ST_ASTEXT` | `ST_ASTEXT(geography_expression) → STRING` | Returns a geography as WKT. |
| `ST_AZIMUTH` | `ST_AZIMUTH(point_geography_1, point_geography_2) → FLOAT64` | Returns the azimuth from one point to another, in radians. |
| `ST_BOUNDARY` | `ST_BOUNDARY(geography_expression) → GEOGRAPHY` | Returns the boundary of a geography. |
| `ST_BUFFER` | `ST_BUFFER(geography, buffer_radius, [num_seg_quarter_circle => int], [use_spheroid => bool], [endcap => string], [side => string]) → GEOGRAPHY` | Returns the area within a distance of a geography. |
| `ST_CENTROID` | `ST_CENTROID(geography_expression) → GEOGRAPHY` | Returns the centroid of a geography. |
| `ST_CLOSESTPOINT` | `ST_CLOSESTPOINT(geography_1, geography_2, [use_spheroid]) → GEOGRAPHY` | Returns the point of the first geography closest to the second. |
| `ST_CLUSTERDBSCAN` | `ST_CLUSTERDBSCAN(geography_column, epsilon, minimum_geographies) → INT64` | Assigns geographies to clusters with DBSCAN (an analytic function). |
| `ST_CONTAINS` | `ST_CONTAINS(geography_1, geography_2) → BOOL` | Tells whether the first geography contains the second. |
| `ST_CONVEXHULL` | `ST_CONVEXHULL(geography_expression) → GEOGRAPHY` | Returns the convex hull of a geography. |
| `ST_COVEREDBY` | `ST_COVEREDBY(geography_1, geography_2) → BOOL` | Tells whether the first geography is covered by the second. |
| `ST_COVERS` | `ST_COVERS(geography_1, geography_2) → BOOL` | Tells whether the first geography covers the second. |
| `ST_DIFFERENCE` | `ST_DIFFERENCE(geography_1, geography_2) → GEOGRAPHY` | Returns the part of the first geography outside the second. |
| `ST_DIMENSION` | `ST_DIMENSION(geography_expression) → INT64` | Returns the dimension of a geography's highest-dimension part. |
| `ST_DISJOINT` | `ST_DISJOINT(geography_1, geography_2) → BOOL` | Tells whether two geographies have no point in common. |
| `ST_DISTANCE` | `ST_DISTANCE(geography_1, geography_2, [use_spheroid]) → FLOAT64` | Returns the shortest distance between two geographies, in meters. |
| `ST_DWITHIN` | `ST_DWITHIN(geography_1, geography_2, distance, [use_spheroid]) → BOOL` | Tells whether two geographies are within a distance of each other. |
| `ST_EQUALS` | `ST_EQUALS(geography_1, geography_2) → BOOL` | Tells whether two geographies are the same point set. |
| `ST_EXTENT` | `ST_EXTENT(geography_expression) → STRUCT<xmin FLOAT64, ymin FLOAT64, xmax FLOAT64, ymax FLOAT64>` | Returns the bounding box of the geographies of a group (an aggregate). |
| `ST_GEOGFROM` | `ST_GEOGFROM(expression) → GEOGRAPHY` | Reads a geography from WKT, WKB or GeoJSON. |
| `ST_GEOGFROMGEOJSON` | `ST_GEOGFROMGEOJSON(geojson_string, [make_valid => constant_expression]) → GEOGRAPHY` | Reads a geography from GeoJSON. |
| `ST_GEOGFROMTEXT` | `ST_GEOGFROMTEXT(wkt_string, [oriented => boolean_constant], [planar => boolean_constant], [make_valid => boolean_constant]) → GEOGRAPHY` | Reads a geography from WKT. |
| `ST_GEOGFROMWKB` | `ST_GEOGFROMWKB(wkb_bytes_expression, [oriented => boolean_constant], [planar => boolean_constant], [make_valid => boolean_constant]) → GEOGRAPHY` | Reads a geography from WKB. |
| `ST_GEOGPOINT` | `ST_GEOGPOINT(longitude, latitude) → GEOGRAPHY` | Makes a point from a longitude and a latitude. |
| `ST_GEOGPOINTFROMGEOHASH` | `ST_GEOGPOINTFROMGEOHASH(geohash) → GEOGRAPHY` | Returns the center of a GeoHash box. |
| `ST_GEOHASH` | `ST_GEOHASH(geography_expression, [maxchars]) → STRING` | Returns the GeoHash of a point. |
| `ST_INTERSECTION` | `ST_INTERSECTION(geography_1, geography_2) → GEOGRAPHY` | Returns the points two geographies share. |
| `ST_INTERSECTS` | `ST_INTERSECTS(geography_1, geography_2) → BOOL` | Tells whether two geographies share a point. |
| `ST_ISCOLLECTION` | `ST_ISCOLLECTION(geography_expression) → BOOL` | Tells whether a geography has more than one part. |
| `ST_ISEMPTY` | `ST_ISEMPTY(geography_expression) → BOOL` | Tells whether a geography is empty. |
| `ST_LENGTH` | `ST_LENGTH(geography_expression, [use_spheroid]) → FLOAT64` | Returns the total length of a geography's lines, in meters. |
| `ST_MAKELINE` | `ST_MAKELINE(geography_1, geography_2) → GEOGRAPHY`<br>`ST_MAKELINE(array_of_geography) → GEOGRAPHY` | Makes a line from points or lines. |
| `ST_MAKEPOLYGON` | `ST_MAKEPOLYGON(polygon_shell, [array_of_polygon_holes]) → GEOGRAPHY` | Makes a polygon from a shell and optional holes. |
| `ST_MAXDISTANCE` | `ST_MAXDISTANCE(geography_1, geography_2, [use_spheroid]) → FLOAT64` | Returns the longest distance between two geographies, in meters. |
| `ST_NPOINTS` | `ST_NPOINTS(geography_expression) → INT64` | Returns the number of vertices of a geography. |
| `ST_NUMPOINTS` | `ST_NUMPOINTS(geography_expression) → INT64` | Returns the number of vertices of a geography. |
| `ST_PERIMETER` | `ST_PERIMETER(geography_expression, [use_spheroid]) → FLOAT64` | Returns the length of a geography's polygon boundaries, in meters. |
| `ST_SIMPLIFY` | `ST_SIMPLIFY(geography, tolerance_meters) → GEOGRAPHY` | Simplifies a geography within a tolerance in meters. |
| `ST_SNAPTOGRID` | `ST_SNAPTOGRID(geography_expression, grid_size) → GEOGRAPHY` | Snaps a geography's vertices to a grid of degrees. |
| `ST_TOUCHES` | `ST_TOUCHES(geography_1, geography_2) → BOOL` | Tells whether two geographies meet only at their boundaries. |
| `ST_UNION` | `ST_UNION(geography_1, geography_2) → GEOGRAPHY`<br>`ST_UNION(array_of_geography) → GEOGRAPHY` | Returns the union of geographies. |
| `ST_UNION_AGG` | `ST_UNION_AGG(geography) → GEOGRAPHY` | Returns the union of the geographies of a group (an aggregate). |
| `ST_WITHIN` | `ST_WITHIN(geography_1, geography_2) → BOOL` | Tells whether the first geography is within the second. |
| `ST_X` | `ST_X(point_geography_expression) → FLOAT64` | Returns a point's longitude. |
| `ST_Y` | `ST_Y(point_geography_expression) → FLOAT64` | Returns a point's latitude. |

### Hash

| Function | Signatures | Summary |
| --- | --- | --- |
| `FARM_FINGERPRINT` | `FARM_FINGERPRINT(value) → INT64` | Returns the FarmHash fingerprint of a value. |
| `MD5` | `MD5(input) → BYTES` | Returns the MD5 hash of a value. |
| `SHA1` | `SHA1(input) → BYTES` | Returns the SHA-1 hash of a value. |
| `SHA256` | `SHA256(input) → BYTES` | Returns the SHA-256 hash of a value. |
| `SHA512` | `SHA512(input) → BYTES` | Returns the SHA-512 hash of a value. |

### HyperLogLog++

| Function | Signatures | Summary |
| --- | --- | --- |
| `HLL_COUNT.EXTRACT` | `HLL_COUNT.EXTRACT(sketch) → INT64` | Returns the cardinality estimate of a sketch. |
| `HLL_COUNT.INIT` | `HLL_COUNT.INIT(input, [precision]) → BYTES` | Builds a sketch of the distinct values of a group (an aggregate). |
| `HLL_COUNT.MERGE` | `HLL_COUNT.MERGE(sketch) → INT64` | Merges the sketches of a group and returns their cardinality (an aggregate). |
| `HLL_COUNT.MERGE_PARTIAL` | `HLL_COUNT.MERGE_PARTIAL(sketch) → BYTES` | Merges the sketches of a group into one sketch (an aggregate). |

### JSON

| Function | Signatures | Summary |
| --- | --- | --- |
| `BOOL` | `BOOL(json_expr) → BOOL` | Converts a JSON boolean to BOOL. |
| `FLOAT64` | `FLOAT64(json_expr, [wide_number_mode => {'exact' \| 'round'}]) → FLOAT64` | Converts a JSON number to FLOAT64. |
| `INT64` | `INT64(json_expr) → INT64` | Converts a JSON number to INT64. |
| `JSON_ARRAY` | `JSON_ARRAY([value], ...) → JSON` | Makes a JSON array of the values. |
| `JSON_ARRAY_APPEND` | `JSON_ARRAY_APPEND(json_expr, json_path, value, ...) → JSON` | Appends values to JSON arrays at paths. |
| `JSON_ARRAY_INSERT` | `JSON_ARRAY_INSERT(json_expr, json_path, value, ...) → JSON` | Inserts values into JSON arrays at paths. |
| `JSON_EXTRACT` | `JSON_EXTRACT(json_string_expr, json_path) → STRING or JSON` | Returns the JSON at a path (the legacy form of JSON_QUERY). |
| `JSON_EXTRACT_ARRAY` | `JSON_EXTRACT_ARRAY(json_string_expr, [json_path]) → ARRAY` | Returns the JSON array at a path as an array (legacy). |
| `JSON_EXTRACT_SCALAR` | `JSON_EXTRACT_SCALAR(json_string_expr, [json_path]) → STRING` | Returns the scalar at a path as a STRING (the legacy form of JSON_VALUE). |
| `JSON_EXTRACT_STRING_ARRAY` | `JSON_EXTRACT_STRING_ARRAY(json_string_expr, [json_path]) → ARRAY<STRING>` | Returns the array of scalars at a path as ARRAY<STRING> (legacy). |
| `JSON_KEYS` | `JSON_KEYS(json_expr, [max_depth], [mode => {'strict' \| 'lax' \| 'lax recursive'}]) → ARRAY<STRING>` | Returns the keys of a JSON object, to an optional depth. |
| `JSON_OBJECT` | `JSON_OBJECT([json_key, json_value], ...) → JSON`<br>`JSON_OBJECT(json_key_array, json_value_array) → JSON` | Makes a JSON object from keys and values. |
| `JSON_QUERY` | `JSON_QUERY(json_string_expr, json_path) → STRING or JSON` | Returns the JSON at a path. |
| `JSON_QUERY_ARRAY` | `JSON_QUERY_ARRAY(json_string_expr, [json_path]) → ARRAY` | Returns the JSON array at a path as an array. |
| `JSON_REMOVE` | `JSON_REMOVE(json_expr, json_path, ...) → JSON` | Removes the JSON at paths. |
| `JSON_SET` | `JSON_SET(json_expr, json_path, value, ...) → JSON` | Sets the JSON at paths to values. |
| `JSON_STRIP_NULLS` | `JSON_STRIP_NULLS(json_expr, [json_path], [include_arrays => bool], [remove_empty => bool]) → JSON` | Removes JSON nulls, and optionally empty objects and arrays. |
| `JSON_TYPE` | `JSON_TYPE(json_expr) → STRING` | Returns the type of a JSON value (object, array, string, number, boolean or null). |
| `JSON_VALUE` | `JSON_VALUE(json_string_expr, [json_path]) → STRING` | Returns the scalar at a path as a STRING. |
| `JSON_VALUE_ARRAY` | `JSON_VALUE_ARRAY(json_string_expr, [json_path]) → ARRAY<STRING>` | Returns the array of scalars at a path as ARRAY<STRING>. |
| `LAX_BOOL` | `LAX_BOOL(json_expr) → BOOL` | Converts a JSON value to BOOL where it can, or returns NULL. |
| `LAX_FLOAT64` | `LAX_FLOAT64(json_expr) → FLOAT64` | Converts a JSON value to FLOAT64 where it can, or returns NULL. |
| `LAX_INT64` | `LAX_INT64(json_expr) → INT64` | Converts a JSON value to INT64 where it can, or returns NULL. |
| `LAX_STRING` | `LAX_STRING(json_expr) → STRING` | Converts a JSON value to STRING where it can, or returns NULL. |
| `PARSE_JSON` | `PARSE_JSON(json_string_expr, [wide_number_mode => {'exact' \| 'round'}]) → JSON` | Reads a STRING as JSON. |
| `STRING` | `STRING(json_expr) → STRING` | Converts a JSON string to STRING. |
| `TO_JSON` | `TO_JSON(sql_value, [stringify_wide_numbers => bool]) → JSON` | Converts a value to JSON. |
| `TO_JSON_STRING` | `TO_JSON_STRING(value, [pretty_print]) → STRING` | Converts a value to JSON text, optionally pretty-printed. |

### Mathematical

| Function | Signatures | Summary |
| --- | --- | --- |
| `ABS` | `ABS(X) → type of X` | Returns the absolute value. |
| `ACOS` | `ACOS(X) → FLOAT64` | Returns the inverse cosine, in radians. |
| `ACOSH` | `ACOSH(X) → FLOAT64` | Returns the inverse hyperbolic cosine. |
| `ASIN` | `ASIN(X) → FLOAT64` | Returns the inverse sine, in radians. |
| `ASINH` | `ASINH(X) → FLOAT64` | Returns the inverse hyperbolic sine. |
| `ATAN` | `ATAN(X) → FLOAT64` | Returns the inverse tangent, in radians. |
| `ATAN2` | `ATAN2(X, Y) → FLOAT64` | Returns the angle of the point (Y, X), in radians. |
| `ATANH` | `ATANH(X) → FLOAT64` | Returns the inverse hyperbolic tangent. |
| `CBRT` | `CBRT(X) → FLOAT64` | Returns the cube root. |
| `CEIL` | `CEIL(X) → type of X` | Returns the smallest integral value not less than X. |
| `CEILING` | `CEILING(X) → type of X` | Returns the smallest integral value not less than X (a synonym of CEIL). |
| `COS` | `COS(X) → FLOAT64` | Returns the cosine of an angle in radians. |
| `COSH` | `COSH(X) → FLOAT64` | Returns the hyperbolic cosine. |
| `COSINE_DISTANCE` | `COSINE_DISTANCE(vector1, vector2) → FLOAT64` | Returns the cosine distance between two vectors. |
| `COT` | `COT(X) → FLOAT64` | Returns the cotangent of an angle in radians. |
| `COTH` | `COTH(X) → FLOAT64` | Returns the hyperbolic cotangent. |
| `CSC` | `CSC(X) → FLOAT64` | Returns the cosecant of an angle in radians. |
| `CSCH` | `CSCH(X) → FLOAT64` | Returns the hyperbolic cosecant. |
| `DIV` | `DIV(X, Y) → INT64, NUMERIC or BIGNUMERIC` | Divides X by Y, rounding toward zero. |
| `EUCLIDEAN_DISTANCE` | `EUCLIDEAN_DISTANCE(vector1, vector2) → FLOAT64` | Returns the Euclidean distance between two vectors. |
| `EXP` | `EXP(X) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns e raised to the power X. |
| `FLOOR` | `FLOOR(X) → type of X` | Returns the largest integral value not greater than X. |
| `GREATEST` | `GREATEST(X1, ...) → supertype of the arguments` | Returns the largest argument, or NULL when any is NULL. |
| `IEEE_DIVIDE` | `IEEE_DIVIDE(X, Y) → FLOAT64` | Divides X by Y as IEEE 754 does: dividing by zero gives an infinity or NaN. |
| `IS_INF` | `IS_INF(X) → BOOL` | Tells whether X is an infinity. |
| `IS_NAN` | `IS_NAN(X) → BOOL` | Tells whether X is NaN. |
| `LEAST` | `LEAST(X1, ...) → supertype of the arguments` | Returns the smallest argument, or NULL when any is NULL. |
| `LN` | `LN(X) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns the natural logarithm. |
| `LOG` | `LOG(X, [Y]) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns the logarithm of X, natural or to base Y. |
| `LOG10` | `LOG10(X) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns the base-10 logarithm. |
| `MOD` | `MOD(X, Y) → INT64, NUMERIC or BIGNUMERIC` | Returns the remainder of X divided by Y. |
| `POW` | `POW(X, Y) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns X raised to the power Y. |
| `POWER` | `POWER(X, Y) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns X raised to the power Y (a synonym of POW). |
| `RAND` | `RAND() → FLOAT64` | Returns a pseudo-random FLOAT64 in [0, 1). |
| `RANGE_BUCKET` | `RANGE_BUCKET(point, boundaries_array) → INT64` | Returns the position of a point in an array of sorted boundaries. |
| `ROUND` | `ROUND(X, [N], [rounding_mode]) → type of X` | Rounds X to N decimal places, with an optional rounding mode. |
| `SAFE_ADD` | `SAFE_ADD(X, Y) → supertype of the arguments` | Adds X and Y, or returns NULL on overflow. |
| `SAFE_DIVIDE` | `SAFE_DIVIDE(X, Y) → FLOAT64, NUMERIC or BIGNUMERIC` | Divides X by Y, or returns NULL when Y is zero or on overflow. |
| `SAFE_MULTIPLY` | `SAFE_MULTIPLY(X, Y) → supertype of the arguments` | Multiplies X and Y, or returns NULL on overflow. |
| `SAFE_NEGATE` | `SAFE_NEGATE(X) → type of X` | Negates X, or returns NULL on overflow. |
| `SAFE_SUBTRACT` | `SAFE_SUBTRACT(X, Y) → supertype of the arguments` | Subtracts Y from X, or returns NULL on overflow. |
| `SEC` | `SEC(X) → FLOAT64` | Returns the secant of an angle in radians. |
| `SECH` | `SECH(X) → FLOAT64` | Returns the hyperbolic secant. |
| `SIGN` | `SIGN(X) → type of X` | Returns -1, 0 or +1 for the sign of X. |
| `SIN` | `SIN(X) → FLOAT64` | Returns the sine of an angle in radians. |
| `SINH` | `SINH(X) → FLOAT64` | Returns the hyperbolic sine. |
| `SQRT` | `SQRT(X) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns the square root. |
| `TAN` | `TAN(X) → FLOAT64` | Returns the tangent of an angle in radians. |
| `TANH` | `TANH(X) → FLOAT64` | Returns the hyperbolic tangent. |
| `TRUNC` | `TRUNC(X, [N]) → type of X` | Truncates X toward zero, to N decimal places. |

### Navigation

| Function | Signatures | Summary |
| --- | --- | --- |
| `FIRST_VALUE` | `FIRST_VALUE(value_expression [{RESPECT \| IGNORE} NULLS]) → type of value_expression` | Returns the value at the first row of the window frame. |
| `LAG` | `LAG(value_expression, [offset], [default_expression]) → type of value_expression` | Returns the value at a row a given number of rows before the current one. |
| `LAST_VALUE` | `LAST_VALUE(value_expression [{RESPECT \| IGNORE} NULLS]) → type of value_expression` | Returns the value at the last row of the window frame. |
| `LEAD` | `LEAD(value_expression, [offset], [default_expression]) → type of value_expression` | Returns the value at a row a given number of rows after the current one. |
| `NTH_VALUE` | `NTH_VALUE(value_expression, constant_integer_expression [{RESPECT \| IGNORE} NULLS]) → type of value_expression` | Returns the value at the Nth row of the window frame. |
| `PERCENTILE_CONT` | `PERCENTILE_CONT(value_expression, percentile [{RESPECT \| IGNORE} NULLS]) → FLOAT64, NUMERIC or BIGNUMERIC` | Returns an interpolated percentile of the values. |
| `PERCENTILE_DISC` | `PERCENTILE_DISC(value_expression, percentile [{RESPECT \| IGNORE} NULLS]) → type of value_expression` | Returns the first value at or above a percentile of the values. |

### Net

| Function | Signatures | Summary |
| --- | --- | --- |
| `NET.HOST` | `NET.HOST(url) → STRING` | Returns the host of a URL. |
| `NET.IP_FROM_STRING` | `NET.IP_FROM_STRING(addr_str) → BYTES` | Reads an IPv4 or IPv6 address as BYTES; an error when it is invalid. |
| `NET.IP_NET_MASK` | `NET.IP_NET_MASK(num_output_bytes, prefix_length) → BYTES` | Returns a network mask of a length and prefix. |
| `NET.IP_TO_STRING` | `NET.IP_TO_STRING(addr_bin) → STRING` | Writes an address in BYTES as text. |
| `NET.IP_TRUNC` | `NET.IP_TRUNC(addr_bin, prefix_length) → BYTES` | Keeps the first prefix_length bits of an address. |
| `NET.IPV4_FROM_INT64` | `NET.IPV4_FROM_INT64(integer_value) → BYTES` | Makes an IPv4 address from an integer. |
| `NET.IPV4_TO_INT64` | `NET.IPV4_TO_INT64(addr_bin) → INT64` | Returns an IPv4 address as an integer. |
| `NET.PUBLIC_SUFFIX` | `NET.PUBLIC_SUFFIX(url) → STRING` | Returns the public suffix of a URL's host (such as com or co.uk). |
| `NET.REG_DOMAIN` | `NET.REG_DOMAIN(url) → STRING` | Returns the registered domain of a URL's host. |
| `NET.SAFE_IP_FROM_STRING` | `NET.SAFE_IP_FROM_STRING(addr_str) → BYTES` | Reads an IPv4 or IPv6 address as BYTES, or returns NULL when it is invalid. |

### Numbering

| Function | Signatures | Summary |
| --- | --- | --- |
| `CUME_DIST` | `CUME_DIST() → FLOAT64` | Returns the relative rank of the row, in (0, 1]. |
| `DENSE_RANK` | `DENSE_RANK() → INT64` | Returns the row's rank, with no gaps after ties. |
| `NTILE` | `NTILE(constant_integer_expression) → INT64` | Divides the rows into a number of buckets and returns the row's bucket. |
| `PERCENT_RANK` | `PERCENT_RANK() → FLOAT64` | Returns the row's percentile rank, in [0, 1]. |
| `RANK` | `RANK() → INT64` | Returns the row's rank, with gaps after ties. |
| `ROW_NUMBER` | `ROW_NUMBER() → INT64` | Numbers the rows of the window from 1. |

### Range

| Function | Signatures | Summary |
| --- | --- | --- |
| `GENERATE_RANGE_ARRAY` | `GENERATE_RANGE_ARRAY(range_to_split, step_interval, [include_last_partial_range]) → ARRAY<RANGE>` | Splits a range into an array of ranges of a step. |
| `RANGE` | `RANGE(lower_bound, upper_bound) → RANGE` | Makes a range from a lower and an upper bound. |
| `RANGE_CONTAINS` | `RANGE_CONTAINS(outer_range, inner_range) → BOOL`<br>`RANGE_CONTAINS(range_to_search, value_to_find) → BOOL` | Tells whether a range contains a value or another range. |
| `RANGE_END` | `RANGE_END(range_to_check) → type of the bound` | Returns a range's upper bound. |
| `RANGE_INTERSECT` | `RANGE_INTERSECT(range_a, range_b) → RANGE` | Returns the range two ranges share. |
| `RANGE_OVERLAPS` | `RANGE_OVERLAPS(range_a, range_b) → BOOL` | Tells whether two ranges overlap. |
| `RANGE_SESSIONIZE` | `RANGE_SESSIONIZE(TABLE table_name, range_column, partitioning_columns, [sessionize_option]) → TABLE` | Merges overlapping or adjacent ranges of a table (a table function). |
| `RANGE_START` | `RANGE_START(range_to_check) → type of the bound` | Returns a range's lower bound. |

### Search

| Function | Signatures | Summary |
| --- | --- | --- |
| `SEARCH` | `SEARCH(search_data, search_query, [json_scope => json_scope_value], [analyzer => analyzer_name], [analyzer_options => analyzer_options_values]) → BOOL` | Tells whether text in the data matches every term of a search query. |

### Security

| Function | Signatures | Summary |
| --- | --- | --- |
| `SESSION_USER` | `SESSION_USER() → STRING` | Returns the email address of the user running the query. |

### Statistical aggregate

| Function | Signatures | Summary |
| --- | --- | --- |
| `CORR` | `CORR(X1, X2) → FLOAT64` | Returns the Pearson correlation coefficient of number pairs. |
| `COVAR_POP` | `COVAR_POP(X1, X2) → FLOAT64` | Returns the population covariance of number pairs. |
| `COVAR_SAMP` | `COVAR_SAMP(X1, X2) → FLOAT64` | Returns the sample covariance of number pairs. |
| `STDDEV` | `STDDEV([DISTINCT] expression) → FLOAT64` | Returns the sample standard deviation (a synonym of STDDEV_SAMP). |
| `STDDEV_POP` | `STDDEV_POP([DISTINCT] expression) → FLOAT64` | Returns the population standard deviation. |
| `STDDEV_SAMP` | `STDDEV_SAMP([DISTINCT] expression) → FLOAT64` | Returns the sample standard deviation. |
| `VAR_POP` | `VAR_POP([DISTINCT] expression) → FLOAT64` | Returns the population variance. |
| `VAR_SAMP` | `VAR_SAMP([DISTINCT] expression) → FLOAT64` | Returns the sample variance. |
| `VARIANCE` | `VARIANCE([DISTINCT] expression) → FLOAT64` | Returns the sample variance (a synonym of VAR_SAMP). |

### String

| Function | Signatures | Summary |
| --- | --- | --- |
| `ASCII` | `ASCII(value) → INT64` | Returns the code of the first character or byte. |
| `BYTE_LENGTH` | `BYTE_LENGTH(value) → INT64` | Returns the length in bytes. |
| `CHAR_LENGTH` | `CHAR_LENGTH(value) → INT64` | Returns the length of a STRING in characters. |
| `CHARACTER_LENGTH` | `CHARACTER_LENGTH(value) → INT64` | Returns the length of a STRING in characters (a synonym of CHAR_LENGTH). |
| `CHR` | `CHR(value) → STRING` | Returns the character of a Unicode code point. |
| `CODE_POINTS_TO_BYTES` | `CODE_POINTS_TO_BYTES(ascii_code_points) → BYTES` | Makes BYTES from an array of extended ASCII code points. |
| `CODE_POINTS_TO_STRING` | `CODE_POINTS_TO_STRING(unicode_code_points) → STRING` | Makes a STRING from an array of Unicode code points. |
| `COLLATE` | `COLLATE(value, collate_specification) → STRING` | Attaches a collation to a STRING. |
| `CONCAT` | `CONCAT(value, ...) → STRING or BYTES` | Concatenates STRING or BYTES values. |
| `CONTAINS_SUBSTR` | `CONTAINS_SUBSTR(expression, search_value_literal, [json_scope => json_scope_value]) → BOOL` | Tells whether a value, or any field of it, contains the text, ignoring case. |
| `EDIT_DISTANCE` | `EDIT_DISTANCE(value1, value2, [max_distance => max_distance_value]) → INT64` | Returns the Levenshtein distance between two values. |
| `ENDS_WITH` | `ENDS_WITH(value, suffix) → BOOL` | Tells whether a value ends with a suffix. |
| `FORMAT` | `FORMAT(format_string_expression, data_type_expression, ...) → STRING` | Formats values with a printf-style format string. |
| `FROM_BASE32` | `FROM_BASE32(string_expr) → BYTES` | Decodes base32 text to BYTES. |
| `FROM_BASE64` | `FROM_BASE64(string_expr) → BYTES` | Decodes base64 text to BYTES. |
| `FROM_HEX` | `FROM_HEX(value) → BYTES` | Decodes hexadecimal text to BYTES. |
| `INITCAP` | `INITCAP(value, [delimiters]) → STRING` | Capitalizes the first letter of each word. |
| `INSTR` | `INSTR(value, subvalue, [position], [occurrence]) → INT64` | Returns the position of an occurrence of a subvalue, from 1, or 0. |
| `LEFT` | `LEFT(value, length) → STRING or BYTES` | Returns the first characters or bytes of a value. |
| `LENGTH` | `LENGTH(value) → INT64` | Returns the length in characters (STRING) or bytes (BYTES). |
| `LOWER` | `LOWER(value) → STRING or BYTES` | Returns a value in lower case. |
| `LPAD` | `LPAD(original_value, return_length, [pattern]) → STRING or BYTES` | Pads a value on the left to a length. |
| `LTRIM` | `LTRIM(value, [set_of_characters_to_remove]) → STRING or BYTES` | Removes leading whitespace or the given characters. |
| `NORMALIZE` | `NORMALIZE(value, [normalization_mode]) → STRING` | Normalizes a STRING to a Unicode normalization form. |
| `NORMALIZE_AND_CASEFOLD` | `NORMALIZE_AND_CASEFOLD(value, [normalization_mode]) → STRING` | Normalizes and case-folds a STRING, for comparing without case. |
| `OCTET_LENGTH` | `OCTET_LENGTH(value) → INT64` | Returns the length in bytes (a synonym of BYTE_LENGTH). |
| `REGEXP_CONTAINS` | `REGEXP_CONTAINS(value, regexp) → BOOL` | Tells whether a value matches a regular expression anywhere. |
| `REGEXP_EXTRACT` | `REGEXP_EXTRACT(value, regexp, [position], [occurrence]) → STRING or BYTES` | Returns the first match of a regular expression, or its capturing group. |
| `REGEXP_EXTRACT_ALL` | `REGEXP_EXTRACT_ALL(value, regexp) → ARRAY` | Returns every match of a regular expression. |
| `REGEXP_INSTR` | `REGEXP_INSTR(source_value, regexp, [position], [occurrence], [occurrence_position]) → INT64` | Returns the position of a match of a regular expression, from 1, or 0. |
| `REGEXP_REPLACE` | `REGEXP_REPLACE(value, regexp, replacement) → STRING or BYTES` | Replaces every match of a regular expression. |
| `REGEXP_SUBSTR` | `REGEXP_SUBSTR(value, regexp, [position], [occurrence]) → STRING or BYTES` | Returns a match of a regular expression (a synonym of REGEXP_EXTRACT). |
| `REPEAT` | `REPEAT(original_value, repetitions) → STRING or BYTES` | Repeats a value a number of times. |
| `REPLACE` | `REPLACE(original_value, from_pattern, to_pattern) → STRING or BYTES` | Replaces every occurrence of a pattern. |
| `REVERSE` | `REVERSE(value) → STRING or BYTES` | Returns a value's characters or bytes in reverse order. |
| `RIGHT` | `RIGHT(value, length) → STRING or BYTES` | Returns the last characters or bytes of a value. |
| `RPAD` | `RPAD(original_value, return_length, [pattern]) → STRING or BYTES` | Pads a value on the right to a length. |
| `RTRIM` | `RTRIM(value, [set_of_characters_to_remove]) → STRING or BYTES` | Removes trailing whitespace or the given characters. |
| `SAFE_CONVERT_BYTES_TO_STRING` | `SAFE_CONVERT_BYTES_TO_STRING(value) → STRING` | Converts BYTES to a STRING, replacing invalid UTF-8 with U+FFFD. |
| `SOUNDEX` | `SOUNDEX(value) → STRING` | Returns the Soundex code of a STRING. |
| `SPLIT` | `SPLIT(value, [delimiter]) → ARRAY` | Splits a value on a delimiter (a comma by default). |
| `STARTS_WITH` | `STARTS_WITH(value, prefix) → BOOL` | Tells whether a value starts with a prefix. |
| `STRPOS` | `STRPOS(value, subvalue) → INT64` | Returns the position of the first occurrence of a subvalue, from 1, or 0. |
| `SUBSTR` | `SUBSTR(value, position, [length]) → STRING or BYTES` | Returns part of a value from a position, of an optional length. |
| `SUBSTRING` | `SUBSTRING(value, position, [length]) → STRING or BYTES` | Returns part of a value (a synonym of SUBSTR). |
| `TO_BASE32` | `TO_BASE32(bytes_expr) → STRING` | Encodes BYTES as base32 text. |
| `TO_BASE64` | `TO_BASE64(bytes_expr) → STRING` | Encodes BYTES as base64 text. |
| `TO_CODE_POINTS` | `TO_CODE_POINTS(value) → ARRAY<INT64>` | Returns the code points of a STRING, or the bytes of BYTES. |
| `TO_HEX` | `TO_HEX(bytes) → STRING` | Encodes BYTES as hexadecimal text. |
| `TRANSLATE` | `TRANSLATE(expression, source_characters, target_characters) → STRING or BYTES` | Replaces each source character with its target character. |
| `TRIM` | `TRIM(value, [set_of_characters_to_remove]) → STRING or BYTES` | Removes leading and trailing whitespace or the given characters. |
| `UNICODE` | `UNICODE(value) → INT64` | Returns the code point of the first character. |
| `UPPER` | `UPPER(value) → STRING or BYTES` | Returns a value in upper case. |

### Utility

| Function | Signatures | Summary |
| --- | --- | --- |
| `GENERATE_UUID` | `GENERATE_UUID() → STRING` | Returns a random version 4 UUID as text. |

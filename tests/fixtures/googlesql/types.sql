CREATE TEMP TABLE scratch (
  id INT64 NOT NULL,
  tags ARRAY<STRING>,
  address STRUCT<street STRING, city STRING, `zip code` STRING>,
  history ARRAY<STRUCT<ts TIMESTAMP, prices ARRAY<NUMERIC(10, 2)>>>,
  span RANGE<DATE>,
  payload JSON, place GEOGRAPHY, amount BIGNUMERIC, ok BOOL, raw BYTES
);
SELECT CAST(x AS STRUCT<a INT64, b FLOAT64>), ARRAY<INT64>[1, 2], STRUCT(1 AS a, 'b' AS b);
SELECT a < b, c > d, e <= f, g >= h, i <> j, k != l;

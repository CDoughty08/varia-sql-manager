SELECT COUNT(*), SUM(price), SAFE_DIVIDE(a, b), SAFE.SUBSTR(name, 1, 3),
  NET.HOST(url), SAFE.NET.HOST(url), HLL_COUNT.MERGE(sketch), my_dataset.my_function(x),
  LEFT(name, 2), date, DATE(created_at), CURRENT_DATE, CURRENT_TIMESTAMP(),
  IF(ok, 1, 0), FORMAT('%d', n), ARRAY(SELECT 1), EXTRACT(DAY FROM d)
FROM t LEFT JOIN u ON t.id = u.id
WHERE x IN (1, 2) AND EXISTS (SELECT 1) OR NOT y LIKE 'a%';

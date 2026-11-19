SELECT t.name, `my-proj.analytics.events_2026`.event_id, s.date, s.range
FROM `my-proj.analytics.events_2026` AS t
JOIN `bigquery-public-data`.samples.shakespeare s USING (word)
WHERE t.user_id = @user_id AND t.created > @@script.creation_time
  AND `escaped \` tick` IS NOT NULL;
SELECT @@dataset_id, @@project_id, @@row_count, ?;

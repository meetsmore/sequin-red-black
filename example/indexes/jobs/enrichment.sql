SELECT
  j.id,
  JSONB_BUILD_OBJECT('name', div.name) AS division
FROM "Job" j
LEFT JOIN "Division" div ON div.id = j."divisionId"
WHERE j.id = ANY($1);

SELECT
  t.id
FROM "Client" t
WHERE t.id = ANY($1);

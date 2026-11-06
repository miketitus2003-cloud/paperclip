-- Metadata only. Run through an already authorized PostgreSQL client/session.
-- No connection string or credentials belong in this file or its output.
-- Discover the journal schema and column layout before choosing the export below.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT n.nspname AS journal_schema, c.relname AS journal_table
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = '__drizzle_migrations' AND c.relkind = 'r'
ORDER BY CASE n.nspname WHEN 'drizzle' THEN 0 WHEN 'public' THEN 1 ELSE 2 END, n.nspname;
SELECT table_schema, column_name, data_type
FROM information_schema.columns
WHERE table_name = '__drizzle_migrations'
ORDER BY table_schema, ordinal_position;
ROLLBACK;

-- Separate export, ONLY after discovery confirms drizzle + id/hash/created_at.
-- If public is the discovered schema, explicitly use public instead. If the
-- layout differs or several unexpected schemas exist, stop for review.
-- Execute this transaction alone with psql -X -qAt in an authorized session to
-- obtain a JSON array. Do not run migrations or reconciliation to repair reads.
-- BEGIN READ ONLY;
-- SET LOCAL statement_timeout = '5s';
-- SELECT COALESCE(json_agg(j ORDER BY j.id), '[]'::json)
-- FROM (SELECT id, hash, created_at::text AS created_at
--       FROM "drizzle"."__drizzle_migrations" ORDER BY id) AS j;
-- ROLLBACK;

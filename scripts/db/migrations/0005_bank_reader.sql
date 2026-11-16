ALTER TABLE "cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "phrases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "turns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Hand-written (scripts/db/hand-edits.mjs, 0005): the content agent's read-only role,
-- its column grants and its row-level security policies (docs/DATA.md
-- §Content agent). The role's name is the setting lingo.reader_role when
-- set (tests on a shared server use a throwaway one), else lingo_reader.
-- Roles are cluster-wide: an existing role is reused, after checking it
-- has no power beyond what this grants. The policies apply to that role
-- only, and RLS is enabled, not forced, so the table owner (the app) is
-- unaffected.
DO $$
DECLARE
  reader text := coalesce(nullif(current_setting('lingo.reader_role', true), ''), 'lingo_reader');
  me text := current_user;
  existing record;
  t text;
BEGIN
  IF reader !~ '^lingo_reader[a-z0-9_]{0,50}$' THEN
    RAISE EXCEPTION '0005_bank_reader: lingo.reader_role must look like lingo_reader[a-z0-9_]*, got %', reader;
  END IF;
  SELECT * INTO existing FROM pg_roles WHERE rolname = reader;
  IF NOT FOUND THEN
    IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = me) THEN
      RAISE EXCEPTION '0005_bank_reader: the read-only role % does not exist and % may not create it', reader, me
        USING HINT = format('As a superuser, run: CREATE ROLE %I NOLOGIN; GRANT %I TO %I WITH INHERIT FALSE, SET TRUE; then npm run db:setup again.', reader, reader, me);
    END IF;
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', reader);
  ELSIF existing.rolsuper OR existing.rolbypassrls OR existing.rolcanlogin OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication THEN
    RAISE EXCEPTION '0005_bank_reader: the role % exists with more than read access (superuser, bypassrls, login, createrole, createdb or replication)', reader
      USING HINT = format('As a superuser, run: ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOLOGIN NOCREATEROLE NOCREATEDB NOREPLICATION; then npm run db:setup again.', reader);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = reader) THEN
    RAISE EXCEPTION '0005_bank_reader: the role % is a member of another role, whose privileges it would have', reader
      USING HINT = 'Revoke its memberships (pg_auth_members lists them), then npm run db:setup again.';
  END IF;
  -- The app's own role enters the reader with SET ROLE inside a read-only
  -- transaction: it needs SET on it, and must not inherit it.
  IF NOT pg_has_role(me, reader, 'SET') THEN
    BEGIN
      EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', reader, me);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0005_bank_reader: % may not grant itself the role %', me, reader
        USING HINT = format('As a superuser, run: GRANT %I TO %I WITH INHERIT FALSE, SET TRUE; then npm run db:setup again.', reader, me);
    END;
  END IF;
  -- Exactly these grants in this database, whatever the role had here.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', reader);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', reader);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', reader);
  EXECUTE format('GRANT SELECT ("id", "learner_id", "language_profile_id", "title", "scenario_id", "target_language", "target_variant", "started_at", "ended_at", "turn_count", "summary", "extraction_status") ON "conversations" TO %I', reader);
  EXECUTE format('GRANT SELECT ("id", "conversation_id", "learner_id", "language_profile_id", "idx", "role", "text", "lines", "glosses", "from_client", "created_at") ON "turns" TO %I', reader);
  EXECUTE format('GRANT SELECT ("id", "learner_id", "language_profile_id", "text", "meaning", "source", "starred", "suspended", "first_seen_at", "last_seen_at", "seen_count", "last_practiced_at", "created_at") ON "phrases" TO %I', reader);
  EXECUTE format('GRANT SELECT ("id", "phrase_id", "learner_id", "language_profile_id", "skill", "due", "stability", "stability_fast", "difficulty", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review") ON "cards" TO %I', reader);
  EXECUTE format('GRANT SELECT ("card_id", "learner_id", "language_profile_id", "mode", "rating", "reviewed_at", "card_before") ON "reviews" TO %I', reader);
  FOREACH t IN ARRAY ARRAY['conversations', 'turns', 'phrases', 'cards', 'reviews'] LOOP
    EXECUTE format('CREATE POLICY bank_reader_scope ON %I AS PERMISSIVE FOR SELECT TO %I USING (learner_id = nullif(current_setting(''app.learner_id'', true), '''')::uuid AND language_profile_id = nullif(current_setting(''app.language_profile_id'', true), '''')::uuid)', t, reader);
  END LOOP;
END $$;

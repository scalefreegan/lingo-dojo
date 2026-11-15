// The hand edits to the generated initial migration, in one place: the
// committed 0000_init.sql is exactly `applyHandEdits(<drizzle-kit output>)`.
// scripts/tests/db-drift.test.mjs regenerates the SQL from schema.ts and
// checks that, so schema, snapshot and SQL can't drift apart unnoticed.
//
// The edits, both things drizzle-kit can't express:
//  1. `CREATE EXTENSION IF NOT EXISTS pg_trgm` first, before the
//     gin_trgm_ops indexes need it.
//  2. Composite provenance keys delete with `ON DELETE SET NULL (<col>)`
//     (PostgreSQL 15+), nulling only the link and keeping the not-null
//     owner column. schema.ts declares them with a plain "set null".
//
//   node scripts/db/hand-edits.mjs   re-applies them to 0000_init.sql after
//                                    regenerating it (idempotent)
//
// Later migrations (0001+) are generated as they are; if one ever needs a
// hand edit, add it here the same way and extend the drift test.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_DIR } from "./config.mjs";

export const INITIAL_MIGRATION = path.join(MIGRATIONS_DIR, "0000_init.sql");

const EXTENSION = `-- Hand-added (scripts/db/hand-edits.mjs): trigram search needs pg_trgm before
-- the gin_trgm_ops indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
`;

/** Constraint name → the one column its ON DELETE nulls. */
export const SET_NULL_COLUMNS = {
  auth_sessions_learner_fk: "learner_id",
  phrase_examples_conversation_fk: "conversation_id",
  phrase_examples_turn_fk: "turn_id",
  reviews_conversation_fk: "conversation_id",
};

export function applyHandEdits(generated) {
  let out = generated.startsWith(EXTENSION) ? generated : EXTENSION + generated;
  for (const [name, col] of Object.entries(SET_NULL_COLUMNS)) {
    const line = new RegExp(`(ADD CONSTRAINT "${name}" FOREIGN KEY [^\\n]*?ON DELETE )(set null|SET NULL \\("${col}"\\))`);
    const m = out.match(line);
    if (!m) throw new Error(`hand-edits: no ON DELETE set null for constraint ${name} in the generated SQL`);
    out = out.replace(line, `$1SET NULL ("${col}")`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = fs.readFileSync(INITIAL_MIGRATION, "utf8");
  const after = applyHandEdits(before);
  fs.writeFileSync(INITIAL_MIGRATION, after);
  console.log(before === after ? "hand edits already applied" : `hand edits applied to ${INITIAL_MIGRATION}`);
}

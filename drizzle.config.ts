// drizzle-kit: `npm run db:generate` diffs scripts/db/schema.ts against the
// last snapshot and writes the next SQL migration; commit what it writes.
// Migrations are applied by `npm run db:migrate` / `npm run db:setup`
// (scripts/db/setup.mjs, by hash), never `drizzle-kit migrate` or `push`, so
// the server, the CLI and the tests all run the same migrator.
import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./scripts/db/config.mjs";

// Generating needs no database. In a worktree without DATABASE_URL,
// databaseUrl() refuses to name one, and `generate` still has to work.
let url: string | undefined;
try {
  url = databaseUrl();
} catch {
  url = undefined;
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./scripts/db/schema.ts",
  out: "./scripts/db/migrations",
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
});

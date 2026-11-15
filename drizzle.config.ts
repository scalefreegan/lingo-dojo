// drizzle-kit: `npm run db:generate` diffs scripts/db/schema.ts against the
// last snapshot and writes the next SQL migration; commit what it writes.
// Migrations are applied by `npm run db:migrate` / `npm run db:setup`
// (scripts/db/setup.mjs), not `drizzle-kit migrate`, so the server, the CLI
// and the tests all run the same migrator.
import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./scripts/db/config.mjs";

export default defineConfig({
  dialect: "postgresql",
  schema: "./scripts/db/schema.ts",
  out: "./scripts/db/migrations",
  dbCredentials: { url: databaseUrl() },
  strict: true,
});

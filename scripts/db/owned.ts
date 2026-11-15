// Owned-row queries: the one way route code reads and writes personal rows.
//
// DATA.md promises that a forgotten owner filter is a type error, not a leak.
// That holds by construction here: a scope is made from an owner id, every
// call it offers adds `owner = id` to the WHERE (or sets it on insert), and a
// table without that owner column does not type-check as an argument:
//
//   const mine = forLearner(db, learnerId);
//   await mine.list(phrases, eq(phrases.lang, "es-MX"));   // learner's rows only
//   await mine.insert(phrases, { lang, norm, source });    // learner_id filled in
//   forLearner(db, id).list(users);                        // does not compile
//
// Queries the four verbs cannot express (joins, aggregates, trigram ranking)
// take `mine.where(table, …)`, which still cannot be built without the owner.
// The raw Drizzle handle stays available for the few owner-less lookups (a
// login by username, a session by token hash, migrations); web/server/db.ts
// names it so that use stands out in review.
//
// Erasable TypeScript only, like schema.ts: `node --test` imports it as is.

import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";

/** The Drizzle API the server uses, whichever driver is under it (node-postgres
 *  in the app, PGlite in the tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type OwnerKey = "learnerId" | "userId";

/** A table whose rows are owned through column `K`. */
export type OwnedTable<K extends OwnerKey> = PgTable & { [P in K]: PgColumn };

type Row<T extends PgTable> = T["$inferSelect"];
/** Insert values minus the owner, which the scope supplies. */
type NewRow<T extends PgTable, K extends OwnerKey> = Omit<T["$inferInsert"], K>;

export interface OwnedScope<K extends OwnerKey> {
  readonly ownerId: string;
  /** `owner = id`, and-ed with `cond`: for hand-written queries. */
  where<T extends OwnedTable<K>>(table: T, cond?: SQL): SQL;
  list<T extends OwnedTable<K>>(table: T, cond?: SQL, opts?: { orderBy?: SQL | PgColumn | (SQL | PgColumn)[]; limit?: number }): Promise<Row<T>[]>;
  /** The first matching row, or undefined. */
  get<T extends OwnedTable<K>>(table: T, cond: SQL): Promise<Row<T> | undefined>;
  insert<T extends OwnedTable<K>>(table: T, values: NewRow<T, K> | NewRow<T, K>[]): Promise<Row<T>[]>;
  /** The owner cannot be changed through a scope: it is not in `set`. */
  update<T extends OwnedTable<K>>(table: T, set: Partial<NewRow<T, K>>, cond: SQL): Promise<Row<T>[]>;
  remove<T extends OwnedTable<K>>(table: T, cond: SQL): Promise<Row<T>[]>;
}

/** A scope over the rows owned through `key`. */
export function ownedBy<K extends OwnerKey>(db: Db, key: K, ownerId: string): OwnedScope<K> {
  if (typeof ownerId !== "string" || !ownerId) throw new Error(`owned rows need a ${key}`);
  const where = (table: OwnedTable<K>, cond?: SQL): SQL => and(eq(table[key], ownerId), cond) as SQL;
  // Drizzle's builders are typed per concrete table; over a generic table
  // their result types do not resolve, so the rows are cast back to the
  // table's own row type here, once, rather than at every call site.
  const d = db as any;
  return {
    ownerId,
    where,
    async list(table, cond, opts = {}) {
      let q = d.select().from(table).where(where(table, cond));
      if (opts.orderBy) q = q.orderBy(...[opts.orderBy].flat());
      if (opts.limit !== undefined) q = q.limit(opts.limit);
      return q;
    },
    async get(table, cond) {
      const rows = await d.select().from(table).where(where(table, cond)).limit(1);
      return rows[0];
    },
    async insert(table, values) {
      const list = [values].flat().map((v) => ({ ...(v as object), [key]: ownerId }));
      if (!list.length) return [];
      return d.insert(table).values(list).returning();
    },
    async update(table, set, cond) {
      // A runtime guard too: a caller holding `any` could still smuggle one in.
      if (key in (set as object)) throw new Error(`a scope cannot change ${key}`);
      return d.update(table).set(set).where(where(table, cond)).returning();
    },
    async remove(table, cond) {
      return d.delete(table).where(where(table, cond)).returning();
    },
  };
}

/** Rows a learner owns: packs, conversations, turns, phrases, cards, … */
export const forLearner = (db: Db, learnerId: string) => ownedBy(db, "learnerId", learnerId);

/** Account rows a user owns: learners, auth sessions, settings, agent messages. */
export const forUser = (db: Db, userId: string) => ownedBy(db, "userId", userId);

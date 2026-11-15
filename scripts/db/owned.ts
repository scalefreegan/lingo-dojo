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
// Untyped callers (the .mjs CLIs) get the same rules at runtime: a table
// without the owner column, an owner in the values, or an update/remove with
// no condition all throw. Removing every row a learner owns in a table is
// `removeAllOwned`, never a forgotten condition.
//
// The caller's condition is always parenthesized before it meets the owner
// filter. Drizzle's and() does not wrap a raw sql`a or b`, so
// `owner = $1 and a or b` would match other owners' rows through `b`.
//
// Queries the verbs cannot express (joins, aggregates, trigram ranking) take
// `mine.where(table, …)`, which still cannot be built without the owner. The
// raw Drizzle handle stays available for the few owner-less lookups (a login
// by username, a session by token hash); web/server/db.ts names it so that
// use stands out in review.
//
// Erasable TypeScript only, like schema.ts: `node --test` imports it as is.

import { Column, is, sql, type SQL } from "drizzle-orm";
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
/** Values for SET: plain values or SQL (`sql\`${t.seenCount} + 1\``). */
type SetRow<T extends PgTable, K extends OwnerKey> = { [C in keyof NewRow<T, K>]?: NewRow<T, K>[C] | SQL };

export interface UpsertOptions<T extends PgTable, K extends OwnerKey> {
  /** The unique key's columns besides the owner, which is always added (so a
   *  conflict can only ever be with this owner's own row). */
  target: PgColumn[];
  /** The predicate of a partial unique index, e.g. sql`${phrases.text} is not null`. */
  targetWhere?: SQL;
  /** What to change on a conflict; `excluded.*` is reachable through sql. */
  set: SetRow<T, K>;
}

export interface OwnedScope<K extends OwnerKey> {
  readonly ownerId: string;
  /** `owner = id and (cond)`: for hand-written queries. */
  where<T extends OwnedTable<K>>(table: T, cond?: SQL): SQL;
  list<T extends OwnedTable<K>>(table: T, cond?: SQL, opts?: { orderBy?: SQL | PgColumn | (SQL | PgColumn)[]; limit?: number }): Promise<Row<T>[]>;
  /** The first matching row, or undefined. */
  get<T extends OwnedTable<K>>(table: T, cond: SQL): Promise<Row<T> | undefined>;
  insert<T extends OwnedTable<K>>(table: T, values: NewRow<T, K> | NewRow<T, K>[]): Promise<Row<T>[]>;
  /** INSERT … ON CONFLICT (owner, …target) [WHERE targetWhere] DO UPDATE SET
   *  … WHERE owner = id. Returns the inserted or updated rows. */
  upsert<T extends OwnedTable<K>>(table: T, values: NewRow<T, K> | NewRow<T, K>[], opts: UpsertOptions<T, K>): Promise<Row<T>[]>;
  /** The owner cannot be changed through a scope: it is not in `set`. */
  update<T extends OwnedTable<K>>(table: T, set: SetRow<T, K>, cond: SQL): Promise<Row<T>[]>;
  remove<T extends OwnedTable<K>>(table: T, cond: SQL): Promise<Row<T>[]>;
  /** Every row this owner has in `table`. Deliberately its own verb. */
  removeAllOwned<T extends OwnedTable<K>>(table: T): Promise<Row<T>[]>;
}

/** A scope over the rows owned through `key`. */
export function ownedBy<K extends OwnerKey>(db: Db, key: K, ownerId: string): OwnedScope<K> {
  if (typeof ownerId !== "string" || !ownerId) throw new Error(`owned rows need a ${key}`);
  const owner = (table: OwnedTable<K>): PgColumn => {
    const col = (table as unknown as Record<string, unknown>)[key];
    if (!is(col, Column)) throw new Error(`this table has no ${key} column; it can't be used through a ${key} scope`);
    return col as PgColumn;
  };
  const where = (table: OwnedTable<K>, cond?: SQL): SQL =>
    cond ? sql`${owner(table)} = ${ownerId} and (${cond})` : sql`${owner(table)} = ${ownerId}`;
  const needCond = (verb: string, cond: SQL | undefined) => {
    if (!cond) throw new Error(`${verb} needs a condition (removeAllOwned removes every row on purpose)`);
  };
  const noOwnerIn = (values: object) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`a scope sets ${key} itself; don't pass it`);
  };
  const stamp = (table: OwnedTable<K>, values: object | object[]) => {
    owner(table);
    return [values].flat().map((v) => {
      noOwnerIn(v);
      return { ...v, [key]: ownerId };
    });
  };
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
      needCond("get", cond);
      const rows = await d.select().from(table).where(where(table, cond)).limit(1);
      return rows[0];
    },
    async insert(table, values) {
      const list = stamp(table, values);
      if (!list.length) return [];
      return d.insert(table).values(list).returning();
    },
    async upsert(table, values, opts) {
      const list = stamp(table, values);
      if (!list.length) return [];
      noOwnerIn(opts.set);
      const own = owner(table);
      const target = opts.target.includes(own) ? opts.target : [own, ...opts.target];
      return d
        .insert(table)
        .values(list)
        .onConflictDoUpdate({ target, targetWhere: opts.targetWhere, set: opts.set, setWhere: sql`${own} = ${ownerId}` })
        .returning();
    },
    async update(table, set, cond) {
      needCond("update", cond);
      noOwnerIn(set);
      return d.update(table).set(set).where(where(table, cond)).returning();
    },
    async remove(table, cond) {
      needCond("remove", cond);
      return d.delete(table).where(where(table, cond)).returning();
    },
    async removeAllOwned(table) {
      return d.delete(table).where(where(table)).returning();
    },
  };
}

/** Rows a learner owns: packs, conversations, turns, phrases, cards, … */
export const forLearner = (db: Db, learnerId: string) => ownedBy(db, "learnerId", learnerId);

/** Account rows a user owns: learners, auth sessions, settings, agent messages. */
export const forUser = (db: Db, userId: string) => ownedBy(db, "userId", userId);

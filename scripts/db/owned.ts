// Owned-row queries: the one way route code reads and writes personal rows.
//
// DATA.md promises that a forgotten owner filter is a type error, not a leak.
// That holds by construction here: a scope is made from an owner id, every
// call it offers adds `owner = id` to the WHERE (or sets it on insert), and a
// table without that owner column does not type-check as an argument:
//
//   const mine = forLanguageProfile(db, { id, learnerId });
//   await mine.list(phrases, eq(phrases.starred, true));  // that language's rows only
//   await mine.insert(phrases, { lang, text, norm, source }); // both owners filled in
//   forLearner(db, id).list(users);                       // does not compile
//
// Three scopes, one per level of ownership:
//
//   forUser(db, userId)                 account rows (learners, sessions, settings)
//   forLearner(db, learnerId)           a learner's rows (its language profiles)
//   forLanguageProfile(db, { id, learnerId })
//                                       one language's rows (packs, folders,
//                                       pack revisions, conversations, turns,
//                                       and since 0003 the phrase bank: phrases,
//                                       examples, cards, reviews, cloze items)
//
// A language profile's rows carry both owners, and its scope filters on and
// stamps both (`language_profile_id = p and learner_id = l`); the schema's
// composite keys make the pair consistent. The other way round is refused:
// a table with a language_profile_id column doesn't type-check through a
// learner scope (and throws at runtime), so a pack or a conversation can't be
// listed across all of a learner's languages by mistake.
//
// Untyped callers (the .mjs CLIs) get the same rules at runtime: a table
// without the owner column, an owner in the values, or an update/remove with
// no condition all throw. Removing every row an owner has in a table is
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

export type OwnerKey = "learnerId" | "userId" | "languageProfileId";

/** A table whose rows are owned through column(s) `K`. */
export type OwnedTable<K extends OwnerKey> = PgTable & { [P in K]: PgColumn };
/** A table that has none of the columns `X` (a learner scope refuses a
 *  language profile's tables). `never` refuses nothing. */
type Lacking<X extends OwnerKey> = { [P in X]?: never };
/** What a scope over `K`, refusing `X`, takes. */
type Fits<K extends OwnerKey, X extends OwnerKey> = OwnedTable<K> & Lacking<X>;

type Row<T extends PgTable> = T["$inferSelect"];
/** Insert values minus the owner(s), which the scope supplies. */
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

export interface InsertOrIgnoreOptions {
  /** The unique key's columns besides the owner, which is always added. */
  target?: PgColumn[];
  /** The predicate of a partial unique index. */
  targetWhere?: SQL;
}

export interface OwnedScope<K extends OwnerKey, X extends OwnerKey = never> {
  /** The scope's own owner: the user, the learner, or the language profile. */
  readonly ownerId: string;
  /** Every owner column the scope filters on and stamps, with its id. */
  readonly owners: Readonly<Record<K, string>>;
  /** `owner = id and (cond)`: for hand-written queries. */
  where<T extends Fits<K, X>>(table: T, cond?: SQL): SQL;
  list<T extends Fits<K, X>>(table: T, cond?: SQL, opts?: { orderBy?: SQL | PgColumn | (SQL | PgColumn)[]; limit?: number }): Promise<Row<T>[]>;
  /** The first matching row, or undefined. */
  get<T extends Fits<K, X>>(table: T, cond: SQL): Promise<Row<T> | undefined>;
  insert<T extends Fits<K, X>>(table: T, values: NewRow<T, K> | NewRow<T, K>[]): Promise<Row<T>[]>;
  /** INSERT … ON CONFLICT (owner, …target) [WHERE targetWhere] DO UPDATE SET
   *  … WHERE owner = id. Returns the inserted or updated rows. */
  upsert<T extends Fits<K, X>>(table: T, values: NewRow<T, K> | NewRow<T, K>[], opts: UpsertOptions<T, K>): Promise<Row<T>[]>;
  /** INSERT … ON CONFLICT [(owner, …target) [WHERE targetWhere]] DO
   *  NOTHING: the rows actually inserted (none for a conflict). With no
   *  target, any unique conflict skips the row. */
  insertOrIgnore<T extends Fits<K, X>>(table: T, values: NewRow<T, K> | NewRow<T, K>[], opts?: InsertOrIgnoreOptions): Promise<Row<T>[]>;
  /** The owner cannot be changed through a scope: it is not in `set`. */
  update<T extends Fits<K, X>>(table: T, set: SetRow<T, K>, cond: SQL): Promise<Row<T>[]>;
  remove<T extends Fits<K, X>>(table: T, cond: SQL): Promise<Row<T>[]>;
  /** Every row this owner has in `table`. Deliberately its own verb. */
  removeAllOwned<T extends Fits<K, X>>(table: T): Promise<Row<T>[]>;
}

const SCOPE_OF: Record<OwnerKey, string> = { userId: "forUser", learnerId: "forLearner", languageProfileId: "forLanguageProfile" };
const OWNER_NAME: Record<OwnerKey, string> = { userId: "user", learnerId: "learner", languageProfileId: "language profile" };

/**
 * A scope over the rows owned through every key of `owners` (all must
 * match), stamping them all on insert. `primary` is the owner that goes into
 * conflict targets (the unique keys lead with it); `refuse` are owner
 * columns a table must not have to be used here.
 */
function scope<K extends OwnerKey, X extends OwnerKey>(db: Db, owners: Record<K, string>, primary: K, refuse: X[]): OwnedScope<K, X> {
  const keys = Object.keys(owners) as K[];
  for (const key of keys) {
    const v = owners[key];
    if (typeof v !== "string" || !v) throw new Error(`owned rows need a ${key}`);
  }
  const column = (table: PgTable, key: OwnerKey): unknown => (table as unknown as Record<string, unknown>)[key];
  const cols = (table: PgTable): PgColumn[] => {
    for (const key of refuse) {
      if (is(column(table, key), Column)) {
        throw new Error(`this table's rows belong to a ${OWNER_NAME[key]}: use ${SCOPE_OF[key]}, not ${SCOPE_OF[primary]}`);
      }
    }
    return keys.map((key) => {
      const col = column(table, key);
      if (!is(col, Column)) throw new Error(`this table has no ${key} column; it can't be used through a ${key} scope`);
      return col as PgColumn;
    });
  };
  const ownerFilter = (table: PgTable): SQL => sql.join(cols(table).map((c, i) => sql`${c} = ${owners[keys[i]]}`), sql` and `);
  const where = (table: PgTable, cond?: SQL): SQL => (cond ? sql`${ownerFilter(table)} and (${cond})` : ownerFilter(table));
  const needCond = (verb: string, cond: SQL | undefined) => {
    if (!cond) throw new Error(`${verb} needs a condition (removeAllOwned removes every row on purpose)`);
  };
  const noOwnerIn = (values: object) => {
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`a scope sets ${key} itself; don't pass it`);
  };
  const stamp = (table: PgTable, values: object | object[]) => {
    cols(table);
    return [values].flat().map((v) => {
      noOwnerIn(v);
      return { ...v, ...owners };
    });
  };
  const withOwner = (table: PgTable, target: PgColumn[]) => {
    const own = cols(table)[keys.indexOf(primary)];
    return target.includes(own) ? target : [own, ...target];
  };
  // Drizzle's builders are typed per concrete table; over a generic table
  // their result types do not resolve, so the rows are cast back to the
  // table's own row type here, once, rather than at every call site.
  const d = db as any;
  return {
    ownerId: owners[primary],
    owners,
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
      return d
        .insert(table)
        .values(list)
        .onConflictDoUpdate({ target: withOwner(table, opts.target), targetWhere: opts.targetWhere, set: opts.set, setWhere: ownerFilter(table) })
        .returning();
    },
    async insertOrIgnore(table, values, opts = {}) {
      const list = stamp(table, values);
      if (!list.length) return [];
      const conflict = opts.target ? { target: withOwner(table, opts.target), where: opts.targetWhere } : undefined;
      return d.insert(table).values(list).onConflictDoNothing(conflict).returning();
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

/** Rows a learner owns that belong to no single language: its language
 *  profiles. A table with a language_profile_id (packs, conversations, the
 *  phrase bank, …) is refused: use forLanguageProfile. */
export const forLearner = (db: Db, learnerId: string): OwnedScope<"learnerId", "languageProfileId"> =>
  scope(db, { learnerId }, "learnerId", ["languageProfileId"]);

/** Account rows a user owns: learners, auth sessions, settings, agent messages. */
export const forUser = (db: Db, userId: string): OwnedScope<"userId"> => scope(db, { userId }, "userId", []);

/** What identifies a language profile's rows: the profile and its learner. */
export interface LanguageProfileRef {
  id: string;
  learnerId: string;
}

/** Rows one of a learner's languages owns: packs, pack folders, pack
 *  revisions, conversations, turns, and the phrase bank (phrases, examples,
 *  cards, reviews, cloze items). Filters on and stamps both the profile and
 *  its learner. */
export const forLanguageProfile = (db: Db, profile: LanguageProfileRef): OwnedScope<"languageProfileId" | "learnerId"> =>
  scope<"languageProfileId" | "learnerId", never>(db, { languageProfileId: profile?.id, learnerId: profile?.learnerId }, "languageProfileId", []);

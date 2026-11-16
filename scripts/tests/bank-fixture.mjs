// A small bank for the bank MCP's tests (bank-mcp.test.mjs on PGlite,
// bank-mcp.pg.test.mjs on PostgreSQL 17): two accounts, the first's learner
// with two languages, each language with phrases, cards, reviews (lapses),
// conversations and turns, so every test can ask "do I see only mine?".
// Raw SQL through `query(text, params)`, as the table owner. Not a test
// itself (the npm glob is *.test.mjs).

/** Ids of what it made: `mine` is the learner and language the reader is
 *  scoped to; `otherLanguage` is the same learner's other language;
 *  `otherLearner` another account's learner. Each has `learnerId`,
 *  `profileId`, `conversationId`, `phraseIds`. */
export async function seedBank(query) {
  const one = async (text, params) => (await query(text, params))[0];
  const user = async (name) => one("insert into users (username, password_hash) values ($1, 'not-a-real-hash') returning id", [name]);
  const learner = async (userId, name) => one("insert into learners (user_id, name, mode, native_language) values ($1, $2, 'adult', 'English') returning id", [userId, name]);
  const profile = async (learnerId, lang) => one("insert into language_profiles (learner_id, target_language) values ($1, $2) returning id", [learnerId, lang]);

  /** A language's bank: `words` as phrases (each with a reviewed card;
   *  `misses` of them lapsed twice in the last week), one session. */
  async function bank(learnerId, profileId, { words, misses, title, said }) {
    const phraseIds = [];
    for (const [i, [text, meaning]] of words.entries()) {
      const p = await one(
        `insert into phrases (learner_id, language_profile_id, lang, text, norm, meaning, source, seen_count, first_seen_at, last_seen_at)
         values ($1, $2, '', $3, lower($3), $4, 'gloss', 1, now() - interval '20 days', now() - make_interval(days => $5))
         returning id`,
        [learnerId, profileId, text, meaning, i],
      );
      phraseIds.push(p.id);
      const c = await one(
        `insert into cards (phrase_id, learner_id, language_profile_id, skill, due, stability, difficulty, scheduled_days, reps, lapses, state, last_review)
         values ($1, $2, $3, 'recognize', now() + interval '1 day', 2, 5, 1, 3, $4, 2, now() - interval '2 days')
         returning id`,
        [p.id, learnerId, profileId, misses.includes(text) ? 2 : 0],
      );
      if (misses.includes(text)) {
        for (const days of [2, 5]) {
          await query(
            `insert into reviews (card_id, learner_id, language_profile_id, mode, rating, verdict, answer, card_before, reviewed_at)
             values ($1, $2, $3, 'flashcard', 1, 'wrong', 'a typed answer', '{"state": 2}'::jsonb, now() - make_interval(days => $4))`,
            [c.id, learnerId, profileId, days],
          );
        }
      }
    }
    const conv = await one(
      `insert into conversations (learner_id, language_profile_id, pack_snapshot, title, mode, target_language, started_at, ended_at, turn_count, summary)
       values ($1, $2, '{"secret": "pack snapshot"}'::jsonb, $3, 'adult', 'Spanish', now() - interval '1 day', now() - interval '23 hours', 2, $4)
       returning id`,
      [learnerId, profileId, title, `Recap of ${title}.`],
    );
    await query(
      `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, text) values ($1, $2, $3, 0, 'learner', $4)`,
      [conv.id, learnerId, profileId, said],
    );
    await query(
      `insert into turns (conversation_id, learner_id, language_profile_id, idx, role, lines, glosses)
       values ($1, $2, $3, 1, 'master', $4::jsonb, $5::jsonb)`,
      [conv.id, learnerId, profileId, JSON.stringify([{ speaker: "VENDOR", gender: "f", text: "¡Claro que sí!", segments: [] }]), JSON.stringify([{ term: "claro", meaning: "of course" }])],
    );
    return { learnerId, profileId, conversationId: conv.id, phraseIds };
  }

  const a = await user("bank_a");
  const b = await user("bank_b");
  const la = await learner(a.id, "Learner A");
  const lb = await learner(b.id, "Learner B");
  const es = await profile(la.id, "Spanish");
  const de = await profile(la.id, "German");
  const esB = await profile(lb.id, "Spanish");
  const mine = await bank(la.id, es.id, {
    words: [["mercado", "market"], ["¿A cómo?", "how much?"], ["regatear", "to haggle"]],
    misses: ["regatear"],
    title: "At the market",
    said: "quiero dos mangos",
  });
  const otherLanguage = await bank(la.id, de.id, {
    words: [["Markt", "market"], ["Wie viel?", "how much?"]],
    misses: ["Markt"],
    title: "Auf dem Markt",
    said: "zwei Mangos bitte",
  });
  const otherLearner = await bank(lb.id, esB.id, {
    words: [["mercado negro", "black market"], ["secreto", "secret"]],
    misses: ["secreto"],
    title: "Someone else's session",
    said: "other learner's private words",
  });
  return { mine, otherLanguage, otherLearner, userIds: [a.id, b.id] };
}

/**
 * Run `fn` the way the bank MCP reads: a READ ONLY transaction, SET LOCAL
 * ROLE to the reader, the scope set transaction-locally; always rolled
 * back. `readOnly: false` leaves the transaction read-write, to show what
 * the role's grants alone refuse. `scope: null` sets no scope.
 */
export async function asReader(query, role, scope, fn, { readOnly = true } = {}) {
  await query(readOnly ? "begin transaction read only" : "begin");
  try {
    await query(`set local role "${role}"`);
    if (scope) await query("select set_config('app.learner_id', $1, true), set_config('app.language_profile_id', $2, true)", [scope.learnerId, scope.profileId]);
    return await fn();
  } finally {
    await query("rollback");
  }
}

/** The error code a statement fails with (null when it succeeds), in a
 *  savepoint so the transaction goes on. */
export async function codeOf(query, text, params) {
  await query("savepoint probe");
  try {
    await query(text, params);
    await query("release savepoint probe");
    return null;
  } catch (e) {
    await query("rollback to savepoint probe");
    return e.code ?? String(e.message);
  }
}

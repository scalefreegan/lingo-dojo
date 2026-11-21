// The kids word game's wire types (web/server/pictures.ts, docs/DATA.md §Kids
// word game): the game's status and rounds, a tap's reply, and the
// grown-up's view of a word's picture in the phrase bank.

/** What the game, and the grown-up's bank, say about the pictures. Read
 *  from the rows and the ledger only: nothing here starts a call. */
export interface PictureStatus {
  /** Words with a ready picture. */
  pictured: number;
  /** Enough of them for a game (pictures.mjs MIN_PICTURED). */
  ready: boolean;
  /** Pictures being drawn now (a background run for this language). */
  drawing: boolean;
  /** Words still to be judged or drawn. */
  waiting: number;
  /** Today's pictures for this language are used up (the daily cap). */
  limited: boolean;
  /** Why no picture can be drawn (no image provider key), for the
   *  grown-up; null when they can. */
  problem: string | null;
  /** Why words can't be played aloud (no TTS key, no voice for the
   *  locale), for the grown-up; null when they can. */
  audio: string | null;
  /** The picture theme in use (scripts/pictures.mjs PICTURE_THEME). */
  theme: string;
  /** Stock pictures drawn in that theme (the check may match words to them). */
  stock: number;
  /** Ready pictures not in the theme: what Redraw all in the current style
   *  would bring into it. */
  outOfTheme: number;
  /** Pictures waiting for a Redraw all already asked for. */
  restyling: number;
  /** Images drawn for this language in the last 24 hours (the ledger), and
   *  the cap (pictures.mjs PICTURE_DAILY_IMAGES). */
  imagesToday: number;
  imagesCap: number;
  /** Pictures out of the theme that only an image key can redraw (no
   *  stock picture fits, or none is drawn): 0 when there is a key. */
  needKey: number;
}

/** POST /api/pictures/restyle: how many pictures were taken up (moved to
 *  a stock picture at once, or waiting for the background run). */
export interface RestyleReply {
  restyled: number;
  status: PictureStatus;
}

/** GET /api/game, GET /api/pictures. */
export interface GameStatusReply {
  status: PictureStatus;
}

/** One picture on a round's buttons: its id and file (the URL's
 *  cache-busting part: /api/game/pictures/:id/:file). */
export interface GamePicture {
  id: string;
  file: string;
}

/** One round: the word to hear (played from /api/game/audio/:phraseId),
 *  the card version and phrase revision to answer against, and 2-4
 *  pictures, the right one among them. Never the word's text or meaning. */
export interface GameRound {
  phraseId: string;
  version: string;
  revision: string;
  choices: GamePicture[];
}

/** POST /api/game/start: a game's rounds (none when there are too few
 *  pictures yet) and the status. */
export interface GameStartReply {
  rounds: GameRound[];
  status: PictureStatus;
}

/** POST /api/game/answer. */
export interface GameAnswerRequest {
  phraseId: string;
  version: string;
  revision: string;
  submitId: string;
  pictureId: string;
  durationMs?: number;
  tz?: number;
}

/** A tap's reply: whether it was the word's picture, and which that is.
 *  Nothing about a score: the child sees a star or a gentle "this one". */
export interface GameAnswerReply {
  right: boolean;
  pictureId: string;
  /** This same tap was already recorded (a resend). */
  replayed: boolean;
  /** For an adult learner only: the word heard, shown after the tap like
   *  the other adult drills' answers. A kids learner's reply never has it. */
  word?: { text: string; meaning: string | null; reading?: string };
}

export type PictureState = "pending" | "ready" | "none" | "failed" | "removed";

/** A word's picture as the grown-up's phrase bank shows it. */
export interface PhrasePicture {
  id: string;
  status: PictureState;
  description: string | null;
  /** Set while ready. */
  file: string | null;
  /** It is one of the shared stock pictures, not one drawn for this word. */
  stock: boolean;
  /** Ready and drawn in the current picture theme. */
  inTheme: boolean;
  /** Waiting to be brought into the theme (Redraw all). */
  restyling: boolean;
}

/** POST /api/pictures/phrase/:id/draw: a grown-up has a word judged "no
 *  clear picture" drawn anyway. `description` is what the picture should
 *  show (cleaned by the server like the check's own; a learner's name in
 *  it is a 400); left out or blank, the word's meaning is drawn. */
export interface DrawAnywayRequest {
  description?: string;
}

/** GET /api/pictures/phrase/:id and the remove/redraw/draw replies: the
 *  phrase's picture for its words as they are (null: not judged yet). */
export interface PhrasePictureReply {
  picture: PhrasePicture | null;
  status: PictureStatus;
}

/** One word in the picture library's "My word pictures" (GET
 *  /api/pictures/words): a word of the active language with a verdict or a
 *  picture for its words as they are now. */
export interface WordPictureItem {
  phraseId: string;
  text: string | null;
  meaning: string | null;
  picture: PhrasePicture;
}

/** GET /api/pictures/words. */
export interface WordPicturesReply {
  words: WordPictureItem[];
  status: PictureStatus;
}

/* ------------------------------- stock pictures ------------------------------ */

/** One concept of the shared stock set, as the picture library shows it. */
export interface StockConceptView {
  id: string;
  category: string;
  description: string;
  words: string[];
  /** Added from the page (the database): an admin may delete it. The
   *  file's (content/pictures.yaml) are only redrawn. */
  custom: boolean;
  /** Adults only (pictures.yaml's `adults: true`, or the Add form's box):
   *  never offered to, matched for or shown to a kids learner. */
  adults: boolean;
  /** The picture's version in the current theme (the file URL's
   *  cache-busting part: /api/stock-pictures/file/:id/:version), or null
   *  while it isn't drawn. */
  version: string | null;
  /** Waiting in the stock drawing queue, or being drawn now. */
  queued: boolean;
  /** The provider refused it the last time (its moderation), since the
   *  server started. */
  refused: boolean;
}

/** GET /api/stock-pictures: the whole shared set, and the stock drawing's
 *  state. Starts nothing. */
export interface StockListReply {
  theme: string;
  concepts: StockConceptView[];
  /** The caller is an admin: the page shows the write actions. */
  canEdit: boolean;
  /** A stock drawing run is going on. */
  drawing: boolean;
  /** Stock pictures drawn from the page in the last 24 hours, install-wide,
   *  and the cap (pictures.mjs PICTURE_DAILY_STOCK). */
  usedToday: number;
  cap: number;
  /** What one picture costs, in US dollars (an estimate). */
  costEach: number;
  /** Why stock pictures can't be drawn now (no Black Forest Labs key), or null. */
  problem: string | null;
  /** Why the last stock run stopped early (a failure, the cap), or null. */
  stopped: string | null;
  /** Concepts added from the page whose id content/pictures.yaml now has
   *  too: the file's wins (and owns the picture), so these are unused; an
   *  admin may delete them (the row only, never the picture). */
  shadowed: { id: string; category: string; description: string; words: string[]; adults: boolean }[];
}

/** POST /api/stock-pictures/admin/concepts. `words` is a list or a
 *  comma-separated line. */
export interface AddStockConceptRequest {
  name: string;
  category: string;
  description: string;
  words: string[] | string;
  /** Adults only: never offered to or shown to a kids learner. */
  adults?: boolean;
}

/** POST /api/stock-pictures/admin/missing: `count` is the number the page
 *  showed when the admin confirmed (another number now is a 409, so
 *  nothing is queued that wasn't seen and priced). */
export interface DrawMissingRequest {
  count: number;
}

/** An admin's stock write replies with the list as it is now; `queued` is
 *  how many concepts the call put in the drawing queue. */
export interface StockChangeReply extends StockListReply {
  queued?: number;
}

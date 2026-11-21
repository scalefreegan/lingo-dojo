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

/* The wire types live in ../shared/wire.ts, declared once for the server and
 * the client. This re-export keeps the short `./types` import; declare
 * nothing here — a second declaration of a wire shape is the drift that file
 * exists to stop. */
export type * from "../shared/wire";
export type * from "../shared/practice";

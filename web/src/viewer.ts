import { createContext } from "react";

/** Whether the logged-in user is an admin, for the few controls deep in the
 *  tree that only an admin may use (adding a Voice Library voice to the
 *  owner's ElevenLabs account). App provides it. The server refuses those
 *  routes to anyone else (403); hiding the control is the courtesy, not the
 *  guard. */
export const IsAdmin = createContext(false);

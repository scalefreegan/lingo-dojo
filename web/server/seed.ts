import fs from "node:fs";
import path from "node:path";
import { learnerFromProfile } from "../../scripts/auth.mjs";
import { isAgentModel } from "../../scripts/claude.mjs";
import { REPO_ROOT, loadContent, modeRoot } from "../../scripts/content.mjs";
import { normalizeVoiceSettings } from "../../scripts/voice.mjs";
import type { AgentMessage, FirstRunSeed, NewLearner } from "../../scripts/db/accounts.ts";
import type { Mode } from "../shared/wire.ts";

// The first admin's starting data (docs/DATA.md §Auth, first run), read once
// from the files that held it before logins:
//
//   content/profile.yaml        → an adult learner
//   content/kids/profile.yaml   → a kids learner
//   data/voice.json             → user_settings.voice
//   data/settings.json          → user_settings.model
//   data/chat.jsonl             → agent_messages
//
// Each part is skipped quietly when its file is missing or unreadable: a
// fresh clone has the profiles and none of data/. After the first run the
// running app reads none of these files again; the profiles stay as seeds
// and for the offline `npm run export` CLI.

/** LINGO_DATA_DIR when set (resolved against the repo root, like the content
 *  and exports overrides), else <repo>/data. Per call, so a test can point it
 *  at a temp dir. */
export function dataDir(): string {
  const override = process.env.LINGO_DATA_DIR;
  return override ? path.resolve(REPO_ROOT, override) : path.join(REPO_ROOT, "data");
}

const FALLBACK_NAME: Record<Mode, string> = { adult: "Me", kids: "Kid" };

function learnerSeed(mode: Mode): NewLearner | null {
  const root = modeRoot(mode);
  if (!fs.existsSync(path.join(root, "profile.yaml"))) return null;
  // The loader's reading, so the seed is what the app showed until now (a
  // file that is not a mapping loads as {} and seeds a blank learner).
  return learnerFromProfile(loadContent(root).profile, mode, FALLBACK_NAME[mode]) as NewLearner;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const ROLES = new Set(["user", "assistant", "commit"]);

/** data/chat.jsonl's lines; a torn or malformed line is dropped, as the
 *  file reader always did. */
function chatSeed(file: string): AgentMessage[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AgentMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as Partial<AgentMessage>;
      if (typeof m.role === "string" && ROLES.has(m.role) && typeof m.text === "string") {
        out.push({ role: m.role, text: m.text, ts: typeof m.ts === "string" ? m.ts : "" });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export function readFirstRunSeed(): FirstRunSeed {
  const dir = dataDir();
  const voiceRaw = readJson(path.join(dir, "voice.json"));
  const settings = readJson(path.join(dir, "settings.json")) as { model?: unknown } | null;
  return {
    learners: (["adult", "kids"] as Mode[]).map(learnerSeed).filter((l): l is NewLearner => !!l),
    // Normalized on the way in, so the row holds a complete, valid shape.
    voice: voiceRaw && typeof voiceRaw === "object" ? (normalizeVoiceSettings(voiceRaw) as unknown as Record<string, unknown>) : null,
    model: isAgentModel(settings?.model) ? settings.model : null,
    messages: chatSeed(path.join(dir, "chat.jsonl")),
  };
}

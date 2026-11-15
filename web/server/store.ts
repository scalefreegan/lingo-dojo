import { DEFAULT_MODEL, isAgentModel } from "../../scripts/claude.mjs";
import { normalizeVoiceSettings } from "../../scripts/voice.mjs";
import {
  appendAgentMessage, clearAgentMessages, getSettings, listAgentMessages, saveModel, saveVoiceSettings,
} from "../../scripts/db/accounts.ts";
import type { ChatMessage, VoiceSettings } from "../shared/wire.ts";
import { rawDb } from "./db.ts";

// Per-user state that is not content: the content agent's chat transcript,
// its model, and the voice settings and casting. One row of user_settings
// and the user's agent_messages (docs/DATA.md §Accounts), read on every call:
// they are tiny, and a cache would only add a way for two tabs to disagree.
// Before logins these were data/chat.jsonl, data/settings.json and
// data/voice.json; the first admin is seeded from them once (seed.ts), and
// nothing reads them after that.

export async function readHistory(userId: string, last?: number): Promise<ChatMessage[]> {
  return listAgentMessages(rawDb(), userId, last);
}

export async function appendHistory(userId: string, message: ChatMessage): Promise<void> {
  await appendAgentMessage(rawDb(), userId, message);
}

export async function clearHistory(userId: string): Promise<void> {
  await clearAgentMessages(rawDb(), userId);
}

/** The model this user's agent runs use. Anything outside the offered list
 *  falls back to the default, so a stale row can never spawn a model the UI
 *  doesn't offer. */
export async function getModel(userId: string): Promise<string> {
  const model = (await getSettings(rawDb(), userId))?.model;
  return isAgentModel(model) ? model : DEFAULT_MODEL;
}

export async function setModel(userId: string, model: string): Promise<string> {
  if (!isAgentModel(model)) throw new Error(`unknown model: ${model}`);
  await saveModel(rawDb(), userId, model);
  return model;
}

/** This user's voice settings, always complete: normalizeVoiceSettings fills
 *  what was never saved (a new user gets the defaults). */
export async function readVoiceSettings(userId: string): Promise<VoiceSettings> {
  return normalizeVoiceSettings((await getSettings(rawDb(), userId))?.voice ?? null);
}

/** Normalize and store; returns what was stored. */
export async function writeVoiceSettings(userId: string, s: VoiceSettings): Promise<VoiceSettings> {
  const clean = normalizeVoiceSettings(s);
  await saveVoiceSettings(rawDb(), userId, clean as unknown as Record<string, unknown>);
  return clean;
}

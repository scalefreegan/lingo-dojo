import { DEFAULT_MODEL, isAgentModel } from "../../scripts/claude.mjs";
import { normalizeVoiceSettings } from "../../scripts/voice.mjs";
import {
  type AgentMessageScope, appendAgentMessage, clearAgentMessages, getSettings, listAgentMessages, saveModel, updateVoiceSettings as updateStoredVoice,
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

/** The transcript, oldest first. With `scope`, only the messages a run
 *  reading that bank (a language profile id, or null for none) may be
 *  shown: see AgentMessageScope (scripts/db/accounts.ts). */
export async function readHistory(userId: string, last?: number, scope?: AgentMessageScope): Promise<ChatMessage[]> {
  return listAgentMessages(rawDb(), userId, last, scope);
}

/** `bank`: the language profile whose bank the run could read, if any. */
export async function appendHistory(userId: string, message: ChatMessage, bank: string | null = null): Promise<void> {
  await appendAgentMessage(rawDb(), userId, message, bank);
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

/** Change this user's voice settings: `change` gets the current settings
 *  (complete, normalized) and returns the new ones, which are normalized and
 *  stored. Atomic per user (accounts.ts updateVoiceSettings: one transaction
 *  holding the row lock), so two saves at once both land instead of the
 *  second undoing the first; the file this replaced was written
 *  synchronously and couldn't interleave. Returns what was stored. */
export async function updateVoiceSettings(userId: string, change: (cur: VoiceSettings) => VoiceSettings): Promise<VoiceSettings> {
  const stored = await updateStoredVoice(rawDb(), userId, (raw) => {
    return normalizeVoiceSettings(change(normalizeVoiceSettings(raw))) as unknown as Record<string, unknown>;
  });
  return stored as unknown as VoiceSettings;
}

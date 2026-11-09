// Headless Claude Code CLI wrapper — the embedded agent runtime (sibling
// pattern from travel-guide / wine-guide). Spawns `claude -p`, stdin ignored
// (the CLI stalls waiting on a piped stdin in -p mode), detached so the whole
// process group can be killed (the CLI spawns children).
//
// The permissions are the whole point of this file. The agent may Read the
// repo and may Write/Edit ONLY under content/; everything else is closed by
// three layers (see buildArgs). It runs on the user's Claude Code login, never
// an API key.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, contentRoot } from "./content.mjs";
import { VOICE_MODELS } from "./voice.mjs";

/* -------------------------------- models --------------------------------- */

/** The models offered for agent work. `id` is what the CLI's --model accepts.
 *  Sonnet is the default: content edits are small, and the newest ids are
 *  Opus 5.5 / Sonnet 5.5 / Fable 5.1. */
export const AGENT_MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "quick and cheap, the default" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "deeper, slower, dearer" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "most capable, most expensive" },
];

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function isAgentModel(id) {
  return AGENT_MODELS.some((m) => m.id === id);
}

/** Any model a run may name: the agent's list plus the voice turns' (which
 *  adds Haiku — fine for a one-line spoken reply, too light for editing). */
export function isKnownModel(id) {
  return isAgentModel(id) || VOICE_MODELS.some((m) => m.id === id);
}

/* ------------------------------ failure hints ----------------------------- */

// Recognize known headless-CLI failures so callers can say what to actually do
// ("sign in again", "wait for the limit to reset") instead of a cryptic exit code.
const AUTH_ERROR_RE = /invalid api key|please run \/login|not logged in|log ?in again|login expired|oauth token.{0,40}(expired|revoked|invalid)|authentication[_ ]?error|credentials?.{0,20}(expired|invalid|missing)|unauthorized|re-?authenticate/i;
const LIMIT_ERROR_RE = /usage limit reached|session limit|hit your .{0,20}limit|limit will reset|out of (extra )?usage|rate.?limit(ed|_error)?|\b429\b/i;
const OVERLOAD_ERROR_RE = /overloaded_error|overloaded|529|api.{0,20}(unavailable|internal server error)/i;
const AUTH_FIX = "open a terminal, run `claude`, type `/login` and finish the browser sign-in, then retry here.";

export function failureHint(text) {
  if (AUTH_ERROR_RE.test(text)) return `Claude Code sign-in has expired — ${AUTH_FIX}`;
  if (LIMIT_ERROR_RE.test(text)) {
    // the CLI phrases it "Claude AI usage limit reached|<epoch-seconds>"
    const m = text.match(/limit reached\|(\d{9,13})/);
    const reset = m ? new Date(Number(m[1]) * (m[1].length <= 10 ? 1000 : 1)).toLocaleString() : null;
    return `Claude usage limit reached — not an auth problem. Wait for the limit to reset${reset ? ` (~${reset})` : ""} and retry.`;
  }
  if (OVERLOAD_ERROR_RE.test(text)) return "Claude API is overloaded right now — transient; retry in a minute.";
  return null;
}

/* ------------------------------- the sandbox ------------------------------ */

/**
 * The built-in tools the agent gets AT ALL (`--tools`). This is the structural
 * layer: a tool not named here does not exist for the run, so the list below
 * is a cap, not a race against a registry that grows every CLI release.
 * Read/Glob/Grep for orientation (the repo, docs/CONTENT.md, the existing
 * units); Edit/Write for the content, scoped further by CONTENT_GRANTS.
 */
export const TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];

/**
 * Names denied outright (`--disallowedTools`), the second layer behind
 * `--tools`. Bash/WebFetch/WebSearch/NotebookEdit are the ones the brief names;
 * the rest is the Atlas SANDBOX_DENIED list minus the file tools this agent
 * needs. ToolSearch is deliberately NOT here: Atlas measured that denying it
 * makes the CLI serve every deferred tool up front instead of on demand.
 */
export const DENIED = [
  "Bash", "PowerShell", "WebFetch", "WebSearch", "NotebookEdit",
  "Task", "Agent", "Workflow", "SendMessage",
  "EnterWorktree", "ExitWorktree",
  "ReadMcpResourceTool", "ReadMcpResourceDirTool", "ListMcpResourcesTool",
  "TaskCreate", "TaskOutput", "TaskStop",
];

/**
 * Permission grants (`--allowedTools`). Read/Glob/Grep are approved for the
 * working directory (`--restricted` confines the file tools to cwd, which is
 * the repo root). Edit and Write are approved ONLY for paths under the content
 * directory, with the CLI's path-scoped rule syntax: `Edit(//abs/path/**)`,
 * where the leading `//` means an absolute filesystem path, i.e. `//Users/…`
 * (a single `/` would be relative to the project root). An Edit or Write anywhere else
 * would prompt, and with `--permission-prompts none` a prompt is a denial.
 *
 * Throws when the content directory is not an absolute path inside the repo:
 * `--restricted` would refuse writes there anyway, so a misconfigured
 * LINGO_CONTENT_DIR should fail loudly at spawn time rather than as a run in
 * which every edit is silently denied.
 */
export function contentGrants(contentDir = contentRoot(), repoRoot = REPO_ROOT) {
  const dir = path.resolve(contentDir);
  const rel = path.relative(repoRoot, dir);
  if (!path.isAbsolute(dir) || !rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`content directory must be inside the repo (${repoRoot}), got ${contentDir}`);
  }
  // The rule's `//` stands in for the filesystem root, so the path goes in
  // without its own leading slash: `Edit(//Users/x/repo/content/**)`.
  const rulePath = dir.replace(/^\/+/, "");
  return [`Edit(//${rulePath}/**)`, `Write(//${rulePath}/**)`];
}

/**
 * The argv for one run — pure, so the test pins the sandbox without spawning.
 *
 *   --restricted           ignores the user's, this repo's and local settings
 *                          files (no hooks, no permission rules from the user's
 *                          own setup), confines the file tools to cwd, and
 *                          refuses bypassPermissions.
 *   --permission-prompts none
 *                          there is nobody to answer a prompt; anything that
 *                          would ask is denied automatically.
 *   --mcp-config <empty> --strict-mcp-config
 *                          only the servers in THIS file load — none — rather
 *                          than every MCP server the user has configured
 *                          globally (mail, calendar on this machine).
 *   --no-session-persistence
 *                          the server keeps the history (data/chat.jsonl);
 *                          nothing to resume, so nothing written under
 *                          ~/.claude/projects per run.
 */
export function buildArgs({ prompt, systemPrompt, model = DEFAULT_MODEL, maxTurns = 25, mcpConfigPath, contentDir, repoRoot, tools = "content" }) {
  if (!isKnownModel(model)) throw new Error(`unknown model: ${model}`);
  if (tools !== "content" && tools !== "none") throw new Error(`unknown tool profile: ${tools}`);
  // "none" is the voice turn: a spoken reply needs no file access at all, so
  // `--tools ""` removes every built-in tool and nothing is granted. Fewer
  // tool definitions in the prompt is also a faster first token.
  const toolArgs = tools === "none"
    ? ["--tools", ""]
    : ["--tools", TOOLS.join(","), "--allowedTools", "Read", "Glob", "Grep", ...contentGrants(contentDir, repoRoot)];
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--model", model,
    "--restricted",
    "--permission-prompts", "none",
    "--no-session-persistence",
    ...toolArgs,
    "--disallowedTools", ...DENIED,
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  return args;
}

/**
 * The child's environment: the server's, minus anything that would make the
 * CLI bill an API key instead of the Claude Code login (ANTHROPIC_API_KEY),
 * and minus the markers a parent Claude Code session leaves behind (the dev
 * server is often started from inside one), which a nested CLI reads as
 * "I am a child session" and changes its behaviour on.
 */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}

/* --------------------------------- running -------------------------------- */

/**
 * Classify a finished CLI run — pure, so the trickiest branching in this file
 * is testable without spawning anything. Returns
 *   { ok: true, text, raw }  or  { ok: false, message }.
 */
export function classifyExit({ code, stdout, stderr }) {
  // The CLI can exit 0 with is_error inside the JSON wrapper, or exit
  // non-zero with the real message in the wrapper's `result`.
  let wrapper = null;
  try { wrapper = JSON.parse(stdout); } catch { /* not a JSON envelope */ }
  if (code !== 0 || (wrapper && wrapper.is_error)) {
    // ERROR envelopes carry `errors[]`, not `result` — subtypes like
    // error_max_turns say what went wrong ONLY there.
    const envelopeErrors = wrapper && Array.isArray(wrapper.errors)
      ? wrapper.errors.filter((e) => typeof e === "string").join("; ")
      : "";
    const resultText = wrapper && wrapper.result ? String(wrapper.result) : "";
    const hint = failureHint(wrapper ? `${stderr}\n${resultText}` : `${stderr}\n${stdout}`);
    if (hint) return { ok: false, message: hint };
    const detail = stderr.trim() || resultText || envelopeErrors || stdout.trim();
    return {
      ok: false,
      message: detail
        ? `claude exited ${code}: ${detail.slice(0, 800)}`
        : `claude exited ${code} with no error output — most often an expired sign-in: ${AUTH_FIX}`,
    };
  }
  return { ok: true, text: wrapper && typeof wrapper.result === "string" ? wrapper.result : stdout, raw: wrapper };
}

// Agents are spawned detached (own process group), so nothing kills them for
// free when THIS process dies — a SIGTERM'd server (the Mac app's Quit, a
// pkill) would orphan an in-flight agent to keep editing content/ with no
// owner. Track every live kill handle and reap them on fatal signals.
const liveKills = new Set();
let reaperArmed = false;
function armReaper() {
  if (reaperArmed) return;
  reaperArmed = true;
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
    process.on(sig, () => {
      for (const kill of liveKills) {
        try { kill(); } catch { /* group already gone */ }
      }
      process.exit(code);
    });
  }
}

/**
 * Start a headless agent run. Returns { result, kill } — `result` resolves to
 *   { text, costUsd, numTurns, durationMs, usage, permissionDenials, raw }
 * where `text` is the agent's final reply (unwrapped from the --output-format
 * json envelope), and `kill()` SIGKILLs the process group. `signal` (an
 * AbortSignal) does the same when it fires — wire it to request-close.
 */
export function startClaude({ prompt, systemPrompt, model, cwd = REPO_ROOT, signal, maxTurns = 25, timeoutSec = 600, tools = "content" }) {
  const chosen = model ?? DEFAULT_MODEL;
  // Say which model actually went out: a setting that silently failed to
  // apply is otherwise invisible until the bill.
  console.log(`[lingo-dojo] claude: spawning ${chosen} (${tools === "none" ? "no tools" : "content tools"}, max ${maxTurns} turns, ${timeoutSec}s timeout)`);

  // An EMPTY MCP config under --strict-mcp-config: see buildArgs.
  let mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-dojo-mcp-"));
  const mcpConfigPath = path.join(mcpDir, "mcp.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const cleanupMcp = () => {
    if (!mcpDir) return;
    const dir = mcpDir;
    mcpDir = null;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait for the OS */ }
  };

  const args = buildArgs({ prompt, systemPrompt, model: chosen, maxTurns, mcpConfigPath, tools });
  const proc = spawn("claude", args, {
    cwd,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let killed = false;
  const kill = () => { killed = true; try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ } };
  armReaper();
  liveKills.add(kill);
  proc.on("close", () => { liveKills.delete(kill); cleanupMcp(); });
  // A spawn failure (ENOENT) can emit 'error' with no 'close' behind it.
  proc.on("error", cleanupMcp);
  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
  }

  const result = new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      kill();
      reject(new Error(`claude timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error("`claude` CLI not found in PATH — install Claude Code (https://claude.com/claude-code), then retry"));
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      // our own kill (client disconnect) — not an auth/limit mystery
      if (killed) return reject(new Error("cancelled"));
      const verdict = classifyExit({ code, stdout, stderr });
      if (!verdict.ok) return reject(new Error(verdict.message));
      const raw = verdict.raw ?? {};
      resolve({
        text: verdict.text,
        costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
        numTurns: typeof raw.num_turns === "number" ? raw.num_turns : null,
        durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
        usage: raw.usage ?? null,
        permissionDenials: Array.isArray(raw.permission_denials) ? raw.permission_denials : [],
        raw,
      });
    });
  });

  return { result, kill };
}

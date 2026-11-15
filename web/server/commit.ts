import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, contentRoot } from "../../scripts/content.mjs";
import type { ChatCommit } from "../shared/wire.ts";

// Auto-commit of content/ after an agent turn, so each change the agent makes
// to the library is one `git log` entry and one `git revert` away (saved packs
// are database rows with their own revisions, docs/DATA.md §Packs). Only
// content/ is ever staged: the rest of the working tree may be dirty with the
// user's own work and must stay that way. Never a push.

const execFileP = promisify(execFile);

/** The repository the commits go into: LINGO_REPO_ROOT when set (resolved
 *  against the repo root; the HTTP test points it at a throwaway repo around
 *  its scratch content dir so nothing lands in this one), else this repo.
 *  Read per call, like contentRoot(). */
export function gitRoot(): string {
  const override = process.env.LINGO_REPO_ROOT;
  return override ? path.resolve(REPO_ROOT, override) : REPO_ROOT;
}

/** Every git call is execFile with an argv — never a shell string, since the
 *  commit subject is agent-written text. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 1 << 20 });
  return stdout;
}

/**
 * The commit subject from the agent's reply: the system prompt asks it to end
 * with one line saying what it changed, so the last non-empty line is the
 * summary. Markdown dressing (a bullet, bold, a "Summary:" label) is stripped
 * and the result cut to 72 characters, git's conventional subject width.
 */
export function commitSubject(reply: string): string {
  const lines = reply.split("\n").map((l) => l.trim()).filter(Boolean);
  let line = lines[lines.length - 1] ?? "";
  line = line
    .replace(/^[-*•]\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^(summary|changes?|changed)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) line = "content edited";
  const MAX = 72;
  return line.length > MAX ? `${line.slice(0, MAX - 1).trimEnd()}…` : line;
}

/**
 * Stage and commit whatever changed under `dir` as `<prefix>: <summary>`.
 * Resolves to the `commit` payload rather than throwing: a failed commit must
 * reach the UI as a line the user can read — the write it was recording has
 * already happened — not take down the response (for the chat, a stream the
 * reply already went out on).
 */
async function commitDir(prefix: string, summary: string, dir: string, root: string): Promise<ChatCommit> {
  // A pathspec relative to the repo, so `git status`/`add`/`commit` all name
  // the same tree regardless of how dir was spelled.
  const spec = path.relative(root, dir) || ".";
  try {
    const status = await git(["status", "--porcelain", "--", spec], root);
    if (!status.trim()) return { skipped: true };
    // -A so a file that was deleted or renamed is staged too; the pathspec
    // on `commit` means only these paths are recorded, leaving anything the
    // user had staged elsewhere in the index exactly as it was.
    await git(["add", "-A", "--", spec], root);
    await git(["commit", "-q", "-m", `${prefix}: ${summary}`, "--", spec], root);
    const hash = (await git(["rev-parse", "--short", "HEAD"], root)).trim();
    return { hash, summary };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    return { error: (err.stderr || err.message || String(e)).trim().slice(0, 500) };
  }
}

/** After an agent turn: `agent: <last line of the reply>`, staging content/. */
export function commitContent(reply: string, { repoRoot = gitRoot(), contentDir = contentRoot() } = {}): Promise<ChatCommit> {
  return commitDir("agent", commitSubject(reply), contentDir, repoRoot);
}


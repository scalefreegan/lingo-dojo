// The sandbox the embedded agent runs in, pinned at the argv level — no
// spawn. buildArgs() is pure, so what this checks is exactly what
// startClaude() hands to `claude`.
//   node --test scripts/tests/claude.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { REPO_ROOT } from "../content.mjs";
import { buildArgs, childEnv, classifyExit, contentGrants, DEFAULT_MODEL, DENIED, TOOLS } from "../claude.mjs";

/** The values following every occurrence of a flag, up to the next `--flag`. */
function valuesOf(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  }
  return out;
}

test("content grants are absolute, inside the repo, and use the //abs/** rule syntax", () => {
  const grants = contentGrants();
  const dir = path.join(REPO_ROOT, "content");
  assert.ok(path.isAbsolute(dir));
  // `//` is the filesystem root in a rule, so the absolute path follows it
  // without its own leading slash — `//Users/…`, never `///Users/…`.
  assert.deepEqual(grants, [`Edit(//${dir.slice(1)}/**)`, `Write(//${dir.slice(1)}/**)`]);
  for (const g of grants) assert.ok(!g.includes("///"), g);
  // Each rule's path, with the tool name and `//` turned back into `/`, is
  // absolute and inside the repo.
  for (const g of grants) {
    const p = g.replace(/^\w+\(\/\//, "/").replace(/\/\*\*\)$/, "");
    assert.ok(path.isAbsolute(p), g);
    assert.ok(!path.relative(REPO_ROOT, p).startsWith(".."), `${g} escapes the repo`);
  }
});

test("a content directory outside the repo is refused at spawn time", () => {
  assert.throws(() => contentGrants("/tmp/elsewhere"), /inside the repo/);
  assert.throws(() => contentGrants("../sibling/content", REPO_ROOT), /inside the repo/);
  assert.throws(() => contentGrants(REPO_ROOT), /inside the repo/); // the repo itself is not "under content"
});

test("argv: tools, grants, denials, permissions, model, output format", () => {
  const args = buildArgs({ prompt: "hi", systemPrompt: "SYS", mcpConfigPath: "/tmp/x/mcp.json" });
  const content = path.join(REPO_ROOT, "content");

  assert.deepEqual(args.slice(0, 2), ["-p", "hi"]);
  assert.deepEqual(valuesOf(args, "--output-format"), ["json"]);
  assert.deepEqual(valuesOf(args, "--max-turns"), ["25"]);
  assert.deepEqual(valuesOf(args, "--model"), [DEFAULT_MODEL]);
  assert.deepEqual(valuesOf(args, "--append-system-prompt"), ["SYS"]);
  assert.ok(args.includes("--restricted"), "--restricted confines the file tools to cwd and ignores the user's settings");
  assert.deepEqual(valuesOf(args, "--permission-prompts"), ["none"]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(valuesOf(args, "--mcp-config"), ["/tmp/x/mcp.json"]);
  assert.ok(args.includes("--strict-mcp-config"), "an empty strict MCP config: no inherited servers");

  // The structural layer: only these five built-ins exist for the run.
  assert.deepEqual(valuesOf(args, "--tools"), ["Read,Glob,Grep,Edit,Write"]);
  assert.deepEqual(TOOLS, ["Read", "Glob", "Grep", "Edit", "Write"]);

  // Grants: unscoped Read/Glob/Grep (cwd-confined by --restricted); Edit and
  // Write ONLY under content/.
  const allowed = valuesOf(args, "--allowedTools");
  assert.deepEqual(allowed, ["Read", "Glob", "Grep", `Edit(//${content.slice(1)}/**)`, `Write(//${content.slice(1)}/**)`]);
  assert.ok(!allowed.includes("Edit") && !allowed.includes("Write"), "an unscoped Edit/Write grant would cover the whole repo");

  // Denials: the named dangerous tools, as a second layer behind --tools.
  const denied = valuesOf(args, "--disallowedTools");
  assert.deepEqual(denied, DENIED);
  for (const t of ["Bash", "WebFetch", "WebSearch", "NotebookEdit", "Task", "Agent"]) assert.ok(denied.includes(t), t);
  assert.ok(!denied.includes("ToolSearch"), "denying ToolSearch inverts (Atlas measured it serving every deferred tool)");

  // What must never appear.
  for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"]) {
    assert.ok(!args.includes(bad), bad);
  }
});

test("argv: a model outside the offered list is refused", () => {
  assert.throws(() => buildArgs({ prompt: "x", model: "claude-3-haiku" }), /unknown model/);
  assert.doesNotThrow(() => buildArgs({ prompt: "x", model: "claude-opus-5-5" }));
  assert.doesNotThrow(() => buildArgs({ prompt: "x", model: "claude-fable-5-1" }));
});

test("child env drops the API key and the parent-session markers, keeps the rest", () => {
  const env = childEnv({ PATH: "/usr/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-ant-secret", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/x" });
});

test("classifyExit: success envelope, is_error envelope, non-zero exit", () => {
  const ok = classifyExit({ code: 0, stdout: JSON.stringify({ result: "done", is_error: false, total_cost_usd: 0.01 }), stderr: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "done");
  assert.equal(ok.raw.total_cost_usd, 0.01);

  const maxTurns = classifyExit({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns", errors: ["Reached max turns (25)"] }), stderr: "" });
  assert.equal(maxTurns.ok, false);
  assert.match(maxTurns.message, /max turns/);

  const login = classifyExit({ code: 1, stdout: "", stderr: "Not logged in. Please run /login" });
  assert.equal(login.ok, false);
  assert.match(login.message, /sign-in has expired/);
});

test("argv: the voice turn's profile has no tools and grants nothing", () => {
  // A spoken reply needs no file access: `--tools ""` removes every built-in,
  // and no --allowedTools grant (not even Read) goes out. The rest of the
  // sandbox — restricted, no prompts, the denials — stays.
  const args = buildArgs({ prompt: "hi", model: "claude-haiku-5-5", tools: "none", maxTurns: 1 });
  assert.deepEqual(valuesOf(args, "--tools"), [""]);
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(!args.some((a) => /^(Edit|Write)\(/.test(a)));
  assert.ok(args.includes("--restricted"));
  assert.deepEqual(valuesOf(args, "--permission-prompts"), ["none"]);
  assert.deepEqual(valuesOf(args, "--max-turns"), ["1"]);
  assert.ok(args.includes("--disallowedTools"));
  assert.throws(() => buildArgs({ prompt: "x", tools: "all" }), /unknown tool profile/);
});

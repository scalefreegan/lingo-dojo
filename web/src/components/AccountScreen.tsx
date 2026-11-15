import { useState, type FormEvent } from "react";
import { ApiError, createFirstAccount, login } from "../api";
import type { MeReply } from "../types";
import { Mochi } from "./Mascots";
import { Button, Card, inputClass } from "./ui";

/* The two screens before a session exists: the login form, and — only while
 * there are no accounts at all — "Create the first account", which makes the
 * admin. That is the one sign-up the app has; everyone after is added with
 * `npm run user -- add <name>` (docs/DATA.md §Auth). */
export default function AccountScreen({ kind, onDone }: { kind: "login" | "first-run"; onDone: (me: MeReply) => void }) {
  const first = kind === "first-run";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (first && password !== again) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(first ? await createFirstAccount(username, password) : await login(username, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="flex w-full max-w-sm flex-col gap-4 p-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Mochi size={64} mood={first ? "happy" : "idle"} />
          <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-fg">{first ? "Create the first account" : "Lingo Dojo"}</h1>
          {first ? (
            <p className="text-sm text-fg-2">
              No one has an account yet. This one is the admin: it can use the content agent, and it starts with the learners, voice settings and agent chat this
              copy of Lingo Dojo has now. Add other people later with <code className="font-mono text-xs">npm run user -- add</code>.
            </p>
          ) : (
            <p className="text-sm text-fg-2">Log in to practise.</p>
          )}
        </div>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} data-testid={first ? "first-run-form" : "login-form"}>
          <label className="flex flex-col gap-1 text-sm text-fg-2">
            Username
            <input
              className={inputClass}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-fg-2">
            Password
            <input
              className={inputClass}
              name="password"
              type="password"
              autoComplete={first ? "new-password" : "current-password"}
              required
              minLength={first ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {first && (
            <label className="flex flex-col gap-1 text-sm text-fg-2">
              Password again
              <input
                className={inputClass}
                name="password-again"
                type="password"
                autoComplete="new-password"
                required
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="text-sm text-err" role="alert" data-testid="account-error">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" className="justify-center" disabled={busy}>
            {busy ? (first ? "Creating…" : "Logging in…") : first ? "Create account" : "Log in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

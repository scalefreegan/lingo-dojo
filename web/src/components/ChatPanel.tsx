import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, clearChatHistory, getChatHistory, getSettings, sendChat, setModel } from "../api";
import type { ChatBankScope, ChatCommit, ChatMessage, Mode, SettingsReply } from "../types";
import { Button, inputClass } from "./ui";

/* The embedded agent's chat (wine-guide ChatPanel pattern, trimmed): the
 * transcript from the server, an input that sends on Enter, an elapsed
 * counter while the headless CLI works (it buffers the whole turn, so there
 * is nothing to stream before the reply), the model picker, and the commit
 * line the server reports after each turn. A commit means content/ changed,
 * so the panel asks App to reload the library straight away. One line under
 * the controls says whose phrase bank the agent can read (the server's
 * `bank`, from the history and again from each run's start), so that is
 * never a silent capability. */

/** A deliberately small markdown subset — replies are prose, not documents. */
function inline(s: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${keyBase}b${i}`} className="font-semibold">{m[1]}</strong>);
    else if (m[2]) out.push(<code key={`${keyBase}c${i}`} className="rounded bg-raised px-1 font-mono sm:text-[0.85em]">{m[2]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`u${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-5">
          {list.map((li, n) => <li key={n}>{inline(li, `u${blocks.length}-${n}`)}</li>)}
        </ul>,
      );
    }
    list = [];
  };
  for (const raw of text.trim().split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^\s*[-*•]\s+/, ""));
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.replace(/^#{1,4}\s+/, ""));
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-2">{blocks}</div>;
}

/** A commit the server reported, as a transcript line: "<hash>: <summary>". */
const commitLine = (c: Extract<ChatCommit, { hash: string }>): ChatMessage => ({ role: "commit", text: `${c.hash}: ${c.summary}`, ts: new Date().toISOString() });

export default function ChatPanel({ mode, onContentChanged }: { mode: Mode; onContentChanged: () => Promise<void> | void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsReply | null>(null);
  const [bank, setBank] = useState<ChatBankScope | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getChatHistory().then(
      (h) => {
        if (!live) return;
        setMessages(h.messages);
        setBank(h.bank);
      },
      (e) => live && setError((e as Error).message),
    );
    getSettings().then((s) => live && setSettings(s), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [messages.length, thinking, note, error]);

  async function submit(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    setDraft("");
    setError(null);
    setNote(null);
    setElapsed(0);
    setMessages((m) => [...m, { role: "user", text: message, ts: new Date().toISOString() }]);
    setThinking(true);
    try {
      // No AbortController on purpose: the run edits files, and a kill
      // mid-edit (on an unmount, say) would leave content/ half-written.
      // The server kills the agent only when the connection itself drops.
      await sendChat(mode, message, {
        start: (d) => setBank(d.bank),
        heartbeat: (d) => setElapsed(d.elapsed),
        message: (d) => {
          setMessages((m) => [...m, { role: "assistant", text: d.text, ts: d.ts }]);
          const parts = [
            d.numTurns != null && `${d.numTurns} turn${d.numTurns === 1 ? "" : "s"}`,
            d.costUsd != null && `$${d.costUsd.toFixed(3)}`,
            d.denied > 0 && `${d.denied} tool call${d.denied === 1 ? "" : "s"} denied by the sandbox`,
          ].filter(Boolean);
          if (parts.length) setNote(parts.join(" · "));
        },
        commit: (c) => {
          if ("hash" in c) {
            setMessages((m) => [...m, commitLine(c)]);
            // New or changed units must show up in the slots at once.
            void onContentChanged();
          } else if ("error" in c) {
            setError(`Commit failed: ${c.error}`);
          }
        },
        error: (d) => setError(d.error),
      });
    } catch (e) {
      setError(String((e as Error).message || e));
      // Refused because this page shows another learner or language than
      // the session's (the auth gate is catching up too): the message was
      // never sent, and the bank line must say whose bank the next run
      // would read, so take both from the server again.
      if (e instanceof ApiError && e.code === "stale_learner") {
        getChatHistory().then((h) => {
          setMessages(h.messages);
          setBank(h.bank);
        }, () => undefined);
      }
    } finally {
      setThinking(false);
    }
  }

  async function clear() {
    setError(null);
    setNote(null);
    try {
      await clearChatHistory();
      setMessages([]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pickModel(model: string) {
    // Optimistic, so the select doesn't snap back while the PUT is in flight.
    setSettings((s) => (s ? { ...s, model } : s));
    try {
      setSettings(await setModel(model));
    } catch (e) {
      setError((e as Error).message);
      setSettings(await getSettings().catch(() => null));
    }
  }

  const modelLabel = settings?.models.find((m) => m.id === settings.model)?.label ?? "the agent";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg-3 sm:text-xs">
          Model
          <select
            aria-label="Model"
            className={`${inputClass} py-1 text-sm sm:text-xs`}
            value={settings?.model ?? ""}
            disabled={!settings || thinking}
            onChange={(e) => void pickModel(e.target.value)}
          >
            {settings?.models.map((m) => (
              <option key={m.id} value={m.id} title={m.note}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" className="shrink-0 sm:text-xs" onClick={() => void clear()} disabled={thinking || messages.length === 0}>
          Clear history
        </Button>
      </div>
      {bank && (
        <p className="border-b border-line px-4 py-1.5 text-sm text-fg-3 sm:text-xs" data-testid="chat-bank" title="The agent can read, not change, this learner's phrase bank and past sessions. It is told never to copy personal details into content/.">
          Can read {bank.learner}'s phrase bank and sessions in {bank.language}, read-only{bank.kids ? " (not what they said)" : ""}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && !thinking && (
          <p className="text-sm text-fg-3">
            Ask for a new unit or scenario, or a change to one. The agent edits files under <code className="font-mono sm:text-xs">content/</code>; each
            change becomes a git commit and the library reloads.
          </p>
        )}
        <ol className="flex flex-col gap-3 text-sm">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <li key={i} className="flex justify-end" data-role="user">
                <p className="max-w-[90%] rounded-lg bg-accent-soft px-3 py-2 whitespace-pre-wrap text-fg">{m.text}</p>
              </li>
            ) : m.role === "commit" ? (
              <li key={i} className="text-fg-3 sm:text-xs" data-role="commit">
                Committed <code className="font-mono">{m.text.split(":")[0]}</code>
                {m.text.includes(":") ? `: ${m.text.slice(m.text.indexOf(":") + 1).trim()}` : ""}
              </li>
            ) : (
              <li key={i} className="text-fg-2" data-role="assistant">
                <Rich text={m.text} />
              </li>
            ),
          )}
        </ol>
        {thinking && (
          <p className="mt-3 flex items-center gap-2 text-sm text-fg-3" data-testid="chat-working">
            <span className="inline-block size-2 animate-pulse rounded-full bg-accent" />
            {modelLabel} is working… <span className="font-mono sm:text-xs">{elapsed}s</span>
          </p>
        )}
        {note && !thinking && <p className="mt-2 text-sm text-fg-3 sm:text-xs">{note}</p>}
        {error && (
          <p className="mt-3 rounded-md bg-err-soft px-3 py-2 text-sm whitespace-pre-wrap text-err" role="alert">
            {error}
          </p>
        )}
        <div ref={tail} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
        }}
      >
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(draft);
            }
          }}
          rows={2}
          placeholder="Add a unit, revise a scenario… (Enter to send, Shift+Enter for a new line)"
          className={`${inputClass} max-h-40 resize-none`}
          disabled={thinking}
        />
        <Button variant="primary" type="submit" disabled={thinking || !draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}

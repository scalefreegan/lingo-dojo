# Lingo Dojo.app

A stay-open Dock app wrapping the lingo-dojo dev server — the pattern
worked out for trail-train's Basecamp.app and hardened in wine-guide's Wine
Guide.app (PR #7), copied here. Launch by icon, Lingo Dojo opens in the browser at
the fixed port, quitting the Dock icon stops the server (if the app started
it).

```sh
./macos/build-app.sh     # builds and installs /Applications/Lingo Dojo.app
open -a Lingo Dojo
```

## Anatomy

- **`Lingo Dojo.applescript`** — the Dock face. Stay-open applet: `run`/`reopen`
  start the server (if down), then focus the Chrome tab already on
  http://localhost:38400 or open one (see Chrome tab reuse); `idle` quits
  the Dock icon after **three consecutive** failed health checks (one miss is
  normal — editing any server file restarts Vite, unbinding the port for a
  moment); `quit` pkills vite **only if this app started it** — a server it
  merely adopted (your manual `npm run dev`, a worktree's) is left alone.
  The health check fetches `/` and requires Lingo Dojo's own `<title>`, so a
  stranger on the port is never mistaken for the app.
- **`server-shim.c`** — compiled by `build-app.sh` into
  `Contents/MacOS/LingoDojoServer`, the executable of the nested, faceless
  **Lingo Dojo Server.app** (`Contents/Helpers/`). All it does is `exec` the
  runner script from `Contents/Resources/`. **A working `clang` is a build
  prerequisite.**
- **`server-runner.sh`** — the runner itself, living in
  `Contents/Resources/`. It runs `npm --prefix web run dev` from the repo
  root as its blocking child.

  Two macOS facts force this shape. First, a TCC ~/Documents grant does not
  survive orphaning to launchd: a `nohup`/`disown`'d server is reparented,
  loses its launcher's grant, and dies with a silent EPERM.

  Second — and this one **inverted on 2026-08-29** — the helper's executable
  must be a real Mach-O binary. Before macOS 26.6.2 a plain shell script was
  the shape whose grant stuck, and a compiled variant was silently denied;
  the update reversed it. A script-executable bundle now runs as `/bin/zsh`,
  a platform binary `tccd` will neither prompt for nor match a Full Disk
  Access row against, so no *new* grant can ever be established: silent
  denial, no prompt, and an FDA entry that does nothing. Existing grants were
  honoured, which is why this surfaced only when one was reset. The shim
  restores a promptable identity. If you are reading this after another macOS
  release, re-measure before trusting either direction.
- **`icon.svg`** — icon source (a gold torii gate against a red sun with a white
  speech bubble between the pillars; gold `#f2b949`, red `#b8322b`, cream
  `#f5f1e8` on indigo `#1b1f3a`). `render-icon.sh`
  rasterizes it to `icon-1024.png` with `sips` (which reads SVG and keeps the
  transparent corners — no Pillow or browser needed); `build-app.sh` derives
  the `.icns` ladder from the PNG. No SVG filters: `sips` renders through
  CoreGraphics' basic SVG support, so everything is flat fills.
- The app itself is a build product, not committed; `build-app.sh` is the
  source of truth. Rebuild after changing any of its four inputs —
  `Lingo Dojo.applescript`, `server-shim.c`, `server-runner.sh` or the icon.
  Needs `clang` for the shim. A rebuild changes the helper's code identity,
  which invalidates its TCC grant: if the server then won't start, run
  `tccutil reset All com.scalefreegan.lingodojo.server` and relaunch to get a
  fresh prompt.

## Repo path

Nothing is hardcoded to this machine: `build-app.sh` takes the checkout it
lives in (`macos/..`) and bakes that path into the applet's kill pattern and
the runner's `cd` when it builds. Move or clone the repo, rebuild, and the
launcher follows. Running `macos/server-runner.sh` by hand from the repo
works too — it falls back to its own location when the path isn't baked in.

## First launch — and after every rebuild

macOS may show one Documents-access prompt attributed to "Lingo Dojo Server" —
approve it, or the server dies with EPERM (the runner logs the guidance).
**Every rebuild re-signs the bundles ad hoc, which changes their code
identity (cdhash) — the old TCC grant stops applying and macOS may deny
WITHOUT re-prompting.** Recovery, in order:
1. `tccutil reset SystemPolicyDocumentsFolder com.scalefreegan.lingodojo.server`
   (and the same for `com.scalefreegan.lingodojo`), then relaunch — this clears
   the stale record so a fresh prompt can appear.
2. If still no prompt: System Settings → Privacy & Security → **Full Disk
   Access** → "+" → add
   `/Applications/Lingo Dojo.app/Contents/Helpers/Lingo Dojo Server.app`, then relaunch.

Server log: `~/Library/Logs/LingoDojo.log` (the previous run is kept at
`.log.old`).

The app expects `npm install` to have been run once (repo root and `web/`),
and `npm run db:setup` after any new migration. The launcher starts the server;
it doesn't install dependencies or migrate, and the server refuses to start on
a missing or outdated database (the reason is in the log).

## Port

`web/vite.config.ts` pins the dev server to **38400** (`strictPort`), so the
app's health check and URL are deterministic (Atlas is 38300, Wine Guide 38200, Basecamp
38100; all four can run at once). `npm run dev` by hand uses the same port:
if the app is running, the manual server fails loudly (by design). **A fresh
launch of the app restarts the server:** if this checkout's vite is already
on the port (a manual `npm run dev`, or a server an earlier launch left
running), it is stopped (TERM, then KILL after 10 s) and the app starts its
own, so quitting and reopening the app always runs the current code. A
worktree's server or any other process on the port is never stopped. A
click while the app is already running only focuses the tab, and Quit still
stops only a server this app started. The same applies
to a server that outlives the 30s startup window: the launcher relinquishes
ownership (so it can't kill a still-warming server), later clicks adopt it,
and Quit leaves it — `pkill -f 'lingo-dojo/web.*vite'` by hand if you ever
need it gone.

## Caveats

The bundle id is personal (`com.scalefreegan.lingodojo`) and signing is ad hoc.
This is a personal launcher, not a distributable app.

## Chrome tab reuse

Clicking the icon while Lingo Dojo is already open brings back the Chrome tab
you were using (any tab whose URL starts with the app's localhost URL)
instead of opening a new one; with no such tab it opens one. This needs
Automation access to Google Chrome: the first click after a build asks for
it. If clicks keep opening new tabs, look in `~/Library/Logs/LingoDojo.log`
for a `[launcher] Chrome tab focus failed` line; `-1743` means the access
was refused — enable it under System Settings → Privacy & Security →
Automation, or `tccutil reset AppleEvents <bundle id>` and click again.
An ad-hoc rebuild changes the app's code identity, so macOS may ask again.

While a test or automation Chrome is running (the Playwright MCP's, whose
profile is under `~/Library/Caches/ms-playwright*`, or any Chrome started
with `--remote-debugging-pipe` or `--remote-debugging-port`), the launcher
doesn't script Chrome at all: AppleScript can't tell that instance from
yours, and a tab there has no real microphone or speakers ("Could not open
the microphone: Unable to decode audio data"). It hands the URL to your own
Chrome with `open -n -a 'Google Chrome' --args <url>` instead, which always
makes a new tab. Close the test browser and clicks reuse the tab again.

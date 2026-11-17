-- Lingo Dojo launcher: a stay-open Dock app wrapping the lingo-dojo dev server.
--
-- Why this shape (lifted from wine-guide's Wine Guide.app, itself from
-- trail-train's Basecamp.app): Lingo Dojo is not a static site — research, chat
-- and the bulk queue are Vite dev-server middleware that spawn node and the
-- `claude` CLI, so "the app" IS the dev server plus a browser tab. This
-- applet gives that server real app semantics: launch by icon, a Dock
-- presence while it runs, reopen-to-focus, and Quit stops the server (only
-- if this app started it — see startedByMe).
--
-- Why a helper app runs the actual server (two hard-won macOS facts):
--   1. TCC attribution does not survive orphaning — a nohup/disown'd server
--      is reparented to launchd, loses its launcher's Documents grant, and
--      dies with a silent EPERM (the repo lives under ~/Documents).
--   2. The helper must be its own app bundle, and its executable must be a
--      real compiled binary (macos/server-shim.c, which execs the runner
--      script). macOS 26.6.2 stopped attributing TCC to script-executable
--      bundles — the process is /bin/zsh, which tccd will neither prompt for
--      nor match a Full Disk Access row against — so a script helper is
--      denied silently and no new grant can be established. Before that
--      update the opposite was true; see macos/README.md.
-- So the server runs as the BLOCKING child of "Lingo Dojo Server.app", a faceless
-- helper bundle that stays alive exactly as long as the server does. This
-- applet is the Dock face: Quit pkills vite, which unwinds npm → helper.
--
-- The server runs on the FIXED port below (strictPort in web/vite.config.ts),
-- so health checks and the app URL are deterministic.
-- Built and installed by macos/build-app.sh (osacompile -s for stay-open),
-- which substitutes __LINGODOJO_REPO__ with the checkout it was built from.

property dashUrl : "http://localhost:38400"
-- ($| ) not $: still matches a vite launched with arguments (--host), while
-- excluding `vite build` / `vite preview` whose first arg is a subcommand.
-- Anchored on THIS checkout's path so a worktree's server is never matched.
property killPattern : "__LINGODOJO_REPO__/web/node_modules/.bin/vite($| --)"
property wasUp : false
-- Quit must not kill a server this app merely ADOPTED (a manual `npm run
-- dev`, a worktree's server) — only one it launched itself.
property startedByMe : false
-- One failed health check is not death: editing any server file restarts
-- Vite (the config imports the whole server tree), leaving the port unbound
-- for a few hundred ms. Require several consecutive misses before believing
-- the server is gone.
property downCount : 0

on serverUp()
	-- probe the app root and require Lingo Dojo's own page title, not merely a
	-- 200: any random process answering on the port must not read as ours
	try
		do shell script "curl -s --max-time 2 " & dashUrl & "/"
		return result contains "<title>Lingo Dojo</title>"
	on error
		return false
	end try
end serverUp

on startServer()
	-- -g: launch in the background, never stealing focus. The helper nests
	-- inside THIS bundle (Contents/Helpers/), so resolve it from path to me —
	-- one visible app in /Applications, and the pair can never split up.
	set helperPath to POSIX path of (path to me) & "Contents/Helpers/Lingo Dojo Server.app"
	try
		do shell script "open -g " & quoted form of helperPath
	on error errMsg
		sayFailure("The server helper would not launch: " & errMsg)
		return false
	end try
	set startedByMe to true
	-- warming up can be slow (login-shell init, Vite dep optimize;
	-- and npm install has to have been run once by hand);
	-- poll rather than hope
	repeat 60 times
		if serverUp() then return true
		delay 0.5
	end repeat
	-- Timed out. The server may STILL be seconds from healthy — do not let
	-- quit kill it; relinquish ownership so the next click simply adopts it.
	set startedByMe to false
	sayFailure("The server didn't answer within 30s — it may still be warming up (click the icon again shortly), or it failed: see ~/Library/Logs/LingoDojo.log. First run needs `npm install` in the repo root and web/, and macOS may be waiting on a Documents permission prompt for Lingo Dojo Server.")
	return false
end startServer

-- notifications are easily suppressed system-wide; failures also get a
-- dialog (auto-dismissing) so they can never be fully silent
on sayFailure(msg)
	display notification msg with title "Lingo Dojo"
	try
		display dialog msg with title "Lingo Dojo" buttons {"OK"} default button "OK" giving up after 25
	end try
end sayFailure

on openDashboard()
	-- Prefer focusing a tab already on this app over opening a new one: plain
	-- `open` hands off to the default browser (Chrome), which always makes a
	-- fresh tab, scattering sessions every time the Dock icon is clicked.
	-- Match by URL PREFIX, not equality, so a tab mid-navigation (e.g.
	-- dashUrl & "/practice") still counts as "this app's tab" and is
	-- refocused instead of duplicated. First use prompts for Automation
	-- access to Chrome (System Settings > Privacy & Security > Automation) —
	-- the same one-time dance as the server helper's Documents prompt.
	try
		tell application "Google Chrome"
			set targetWinIndex to 0
			set targetTabIndex to 0
			set winCount to count of windows
			repeat with wi from 1 to winCount
				set tabCount to count of tabs of window wi
				repeat with ti from 1 to tabCount
					if (URL of tab ti of window wi) starts with dashUrl then
						set targetWinIndex to wi
						set targetTabIndex to ti
						exit repeat
					end if
				end repeat
				if targetWinIndex > 0 then exit repeat
			end repeat
			if targetWinIndex > 0 then
				try
					set minimized of window targetWinIndex to false
				end try
				set active tab index of window targetWinIndex to targetTabIndex
				set index of window targetWinIndex to 1
			else if winCount > 0 then
				tell window 1 to make new tab with properties {URL:dashUrl}
			else
				make new window
				set URL of active tab of window 1 to dashUrl
			end if
			activate
		end tell
	on error errMsg
		-- Chrome missing, Automation access not yet granted, or some other
		-- AppleScript failure talking to it: fall back to the old behavior
		-- rather than silently doing nothing.
		do shell script "open " & quoted form of dashUrl
	end try
end openDashboard

-- shared by run and reopen: true when the server is up (started or adopted)
on ensureUp()
	if serverUp() then
		set wasUp to true
		set downCount to 0
		return true
	end if
	if startServer() then
		set wasUp to true
		set downCount to 0
		display notification "Lingo Dojo is open at " & dashUrl with title "Lingo Dojo"
		return true
	end if
	return false
end ensureUp

on run
	if ensureUp() then
		openDashboard()
	else
		quit
		return
	end if
end run

-- double-clicking the icon while already running lands here: focus, don't fork
on reopen
	if ensureUp() then
		openDashboard()
	else
		quit
		return
	end if
end reopen

-- keep the Dock state truthful: if the server stays dead, the icon should
-- not keep claiming it is running. wasUp gates it so a failed FIRST start
-- does not self-destruct mid-diagnosis; downCount tolerates the brief
-- unbound window of a Vite config restart.
on idle
	if serverUp() then
		set wasUp to true
		set downCount to 0
	else if wasUp then
		set downCount to downCount + 1
		if downCount ≥ 3 then quit
	end if
	return 15
end idle

on quit
	if startedByMe then
		try
			do shell script "pkill -f " & quoted form of killPattern
		end try
	end if
	continue quit
end quit

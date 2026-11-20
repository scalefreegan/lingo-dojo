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
-- A fresh launch restarts the server (stopExistingServer), so opening the
-- app always runs the checkout's current code.
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
	-- handled: true once Chrome has focused or opened a tab, so an error
	-- after that point never falls back into a second, duplicate tab
	set handled to false
	try
		tell application "Google Chrome"
			-- activate FIRST: raising a window while Chrome is in the background
			-- can leave the previous window key; and if Chrome was not running,
			-- this restores its session, so a restored tab is found, not duplicated
			activate
			-- remember the window by id, not index: Chrome numbers windows front
			-- to back, so un-minimizing one renumbers the rest
			set targetWinId to missing value
			set targetTabIndex to 0
			repeat with w in (every window)
				set tabCount to count of tabs of w
				repeat with ti from 1 to tabCount
					if (URL of tab ti of w) starts with dashUrl then
						set targetWinId to id of w
						set targetTabIndex to ti
						exit repeat
					end if
				end repeat
				if targetWinId is not missing value then exit repeat
			end repeat
			if targetWinId is not missing value then
				set targetWin to window id targetWinId
				set active tab index of targetWin to targetTabIndex
				set handled to true
				try
					set minimized of targetWin to false
				end try
				set index of targetWin to 1
			else
				-- a new tab goes in a normal, visible window: an incognito one
				-- would not have the app's login, a minimized one shows nothing
				set hostWinId to missing value
				repeat with w in (every window)
					if (mode of w is "normal") and (minimized of w is false) then
						set hostWinId to id of w
						exit repeat
					end if
				end repeat
				if hostWinId is missing value then
					make new window
					set URL of active tab of window 1 to dashUrl
					set handled to true
				else
					tell window id hostWinId to make new tab with properties {URL:dashUrl}
					set handled to true
					set index of window id hostWinId to 1
				end if
			end if
		end tell
	on error errMsg number errNum
		-- log why, since from the outside a refusal looks exactly like "it
		-- still opens a new tab"
		try
			do shell script "echo " & quoted form of ("[launcher] Chrome tab focus failed (" & errNum & "): " & errMsg) & " >> ~/Library/Logs/LingoDojo.log"
		end try
		if errNum is -1743 then
			display notification "Allow Lingo Dojo to control Google Chrome (System Settings > Privacy & Security > Automation) so a click returns to its open tab." with title "Lingo Dojo"
		end if
	end try
	-- Chrome unreachable or Automation refused: the old behavior, never nothing
	if not handled then do shell script "open " & quoted form of dashUrl
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

-- A fresh launch (the icon clicked while the Dock app isn't running) means
-- "give me the app as it is now", so a server already on the port from
-- this checkout is stopped first and a new one started: otherwise a
-- server left running for days (a manual `npm run dev`, or one an earlier
-- launch relinquished) keeps serving whatever it loaded, and quitting and
-- reopening the app changes nothing. Only a server matching killPattern
-- (this checkout's vite) is stopped: a worktree's server, or a stranger on
-- the port, is never touched. A click while the app is running (reopen)
-- still just focuses the tab.
on stopExistingServer()
	try
		do shell script "pgrep -f " & quoted form of killPattern
	on error
		return -- none of ours running
	end try
	try
		do shell script "echo " & quoted form of ("[launcher] fresh launch: stopping the running server " & (current date)) & " >> ~/Library/Logs/LingoDojo.log"
	end try
	try
		do shell script "pkill -f " & quoted form of killPattern
	end try
	-- wait for it to let go of the port (TERM first, KILL after 10 s)
	repeat with i from 1 to 30
		if not portBound() then return
		if i = 20 then
			try
				do shell script "pkill -9 -f " & quoted form of killPattern
			end try
		end if
		delay 0.5
	end repeat
end stopExistingServer

on portBound()
	try
		do shell script "lsof -nP -iTCP:38400 -sTCP:LISTEN -t"
		return true
	on error
		return false
	end try
end portBound

on run
	stopExistingServer()
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

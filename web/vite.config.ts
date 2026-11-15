import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// The API is Vite `apply:"serve"` middleware on the dev server — there is no
// separate backend. See server/api.ts.
import { apiPlugins } from "./server/api.ts";
import { publicHosts } from "../scripts/public-host.mjs";

// The tailnet name `tailscale serve` answers under (docs/DATA.md, Hosting on
// Tailscale). Vite 403s any Host it doesn't know, so it must be listed; it
// comes from the environment so the name is never committed. Unset: nothing
// is added and only localhost works, as before.
const { hosts: allowedHosts, rejected } = publicHosts();
if (rejected.length) {
  console.warn(
    `[lingo-dojo] ignoring LINGO_PUBLIC_HOST entries that are not plain hostnames ` +
      `(no scheme, port, path or wildcard): ${rejected.map((r: string) => JSON.stringify(r)).join(", ")}`,
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugins()],
  // Fixed port so the Mac app (macos/) has a deterministic health-check and
  // dashboard URL; strict so a second instance fails loudly instead of
  // silently serving a twin on the next port. 38400 = Lingo Dojo; Atlas is
  // 38300, Wine Guide 38200 and Basecamp 38100, so all four can run at once.
  // Polling watcher: macOS FSEvents delivery for this directory is broken on
  // this machine (fsevents.watch sees nothing while fs.watch does), which
  // silently kills HMR — edits never reach the browser. Cheap for a project
  // this size; safe to drop if FSEvents recovers after a reboot.
  // content/ and exports/ sit outside web/, so content edits (by the agent or
  // an editor) never trigger a reload; the UI re-reads them through the API.
  // HMR needs no options behind `tailscale serve`: the Vite client opens its
  // websocket on the page's own host and port, wss on an https page (443
  // here), and Tailscale Serve proxies websocket upgrades to 38400.
  // server.ws.clientPort is only for a proxy port the browser can't see.
  // `host` stays default (localhost only): Tailscale is the one way in.
  server: {
    port: 38400,
    strictPort: true,
    watch: { usePolling: true, interval: 300 },
    ...(allowedHosts.length ? { allowedHosts } : {}),
  },
});

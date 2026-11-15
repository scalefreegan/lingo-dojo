// Just enough of connect for apiPlugins().configureServer(), copied from
// Atlas for the HTTP-level test (api.http). Not a test file itself — the npm
// test glob is *.test.mjs.
//
// use(route, fn) mounts fn on a path prefix; a hit sees req.url with the
// prefix stripped (so "/api/packs/x" reaches handlePacks as "/x") and
// next() restores it for the following layer. The prefix has to end at a
// segment boundary, which is what keeps "/api/exports" away from the
// "/api/export" layer.

import http from "node:http";

export function connectStack() {
  const layers = [];
  return {
    use(route, fn) { layers.push({ route: route.replace(/\/+$/, ""), fn }); },
    handle(req, res) {
      let i = 0;
      const next = (err) => {
        if (err) { res.statusCode = 500; res.end(String(err?.message || err)); return; }
        const layer = layers[i++];
        if (!layer) { res.statusCode = 404; res.end("no layer"); return; }
        const url = req.url;
        const pathname = url.split("?")[0];
        const boundary = pathname[layer.route.length];
        if (!pathname.startsWith(layer.route) || (boundary && boundary !== "/" && boundary !== ".")) { next(); return; }
        const rest = url.slice(layer.route.length);
        req.url = rest.startsWith("/") ? rest : `/${rest}`;
        try {
          layer.fn(req, res, (e) => { req.url = url; next(e); });
        } catch (e) {
          req.url = url;
          next(e);
        }
      };
      next();
    },
  };
}

/** Mount the plugin on a stack behind a real node:http server on an
 *  ephemeral port. Returns the base URL and a close(). */
export async function serveApi(apiPlugins) {
  const stack = connectStack();
  // The plugin's own configureServer: every mount in the order the app
  // uses. Only `middlewares` is consulted. No database boot check: these
  // tests must run without a Postgres server.
  apiPlugins({ checkDatabase: false }).configureServer({ middlewares: stack });
  const server = http.createServer((req, res) => stack.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

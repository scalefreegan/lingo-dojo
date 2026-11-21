import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import { sniffPicture, MAX_PICTURE_BYTES } from "../../scripts/picture-store.mjs";
import { PICTURE_THEME } from "../../scripts/pictures.mjs";
import { voiceKeys } from "../../scripts/voice.mjs";

// The image provider behind the kids word game's pictures (docs/DATA.md §Kids
// word game), in one small module so another can be swapped in: the rest of
// the server sees only `imageProvider()` → { key, name, problem(), draw(prompt) }.
// Which one: Black Forest Labs when BFL_API_KEY is set (ld-6k7), else OpenAI
// when OPENAI_API_KEY is, else none (its problem() names both keys).
//
// Black Forest Labs, FLUX 3 Image Klein (BFL_IMAGE). Read on 2026-11-21 from
// docs.bfl.ai: the endpoint reference
// (https://docs.bfl.ml/api-reference/utility/generate-an-image-with-flux-3-klein),
// get_result (https://docs.bfl.ml/api-reference/utility/get-result), the
// integration guidelines (https://docs.bfl.ml/api_integration/integration_guidelines),
// errors (https://docs.bfl.ml/api_integration/errors), credits
// (https://docs.bfl.ml/api-reference/get-the-users-credits) and pricing
// (https://docs.bfl.ml/quick_start/pricing, https://bfl.ai/pricing):
//  - POST https://api.bfl.ai/v1/flux-3-image-klein with the key in the
//    `x-key` header and `{ prompt, resolution: "768sq", output_format:
//    "jpeg", safety_tolerance: 0, seed }`. The body takes nothing else
//    (additionalProperties false); other fields are images (references:
//    not used, see PICTURE_THEME), aspect_ratio, width/height, steps (1-16,
//    default 16) and user. output_format is jpeg or png only (no webp).
//    safety_tolerance is 0-7, 0 the strictest, and stays 0: these are for
//    children. `seed` is the theme's (pictures.mjs PICTURE_THEME): with the
//    theme's lines it is what keeps every picture in one look;
//  - the reply is `{ id, polling_url, cost }`, cost in credits (1 credit =
//    $0.01). The polling_url must be used as given (the guidelines: "you
//    must use the polling_url returned"), but the key is only ever sent to
//    an https URL on *.bfl.ai (bflUrl); anything else is refused unsent.
//    Every BFL request (submit, polls, download) is made with
//    `redirect: "error"` (bflFetch): fetch drops `authorization` on a
//    cross-site redirect but not a custom header like `x-key`, so a 3xx
//    from a bfl.ai host to anywhere else would carry the key along;
//  - polled every 0.5 s (GET polling_url, `x-key`): statuses Task not found,
//    Pending, Reasoning, Generating, Request Moderated, Content Moderated,
//    No Card Generated, Ready, Error. Ready carries `result.sample`, a
//    signed URL that expires after 10 minutes and has no CORS, so the
//    server downloads it at once (no key sent there, no redirect
//    followed), capped at MAX_PICTURE_BYTES and checked by its magic
//    bytes. Only an https URL on *.bfl.ai is fetched (BFL's delivery hosts
//    are delivery.*.bfl.ai; the host of the 2026-11-21 real draws wasn't
//    recorded): anything else, an internal address included, is
//    ImageFailed with no request made;
//  - Request Moderated or Content Moderated is a refusal (ImageRefused: the
//    word is `failed`, never retried by itself). Every other failure,
//    including a total time over BFL_TIMING.totalMs (60 s), is ImageFailed;
//    a task that ended without a picture (Error, No Card Generated, Task
//    not found) or a download that isn't a picture is the word's own
//    (`perWord`): pictures.ts gives up on a word after two in a row;
//  - 402: out of credits; 429: over the account's limit (24 requests at
//    once on most endpoints). Both get a plain log line and the usual
//    backoff (pictures.ts RETRY_AFTER_MS). GET /v1/credits gives the
//    balance (not called by the app);
//  - measured 2026-11-21 with real calls: `cost` 0.8 credits, so $0.008 a
//    picture (OpenAI's gpt-image-2.6-flare measured 824 output tokens, about
//    $0.025); Ready in 3-6 s; a 768x768 JPEG of 100-190 KB. The model and
//    the credits billed are logged per picture, never the prompt or key.
//
// OpenAI Images (POST /v1/images/generations). Read again on 2026-11-20
// (PR #56 review) from OpenAI's deprecations page
// (https://developers.openai.com/api/docs/deprecations), the API reference
// (https://developers.openai.com/api/reference/resources/images), the image
// generation guide (https://developers.openai.com/api/docs/guides/image-generation)
// and the pricing page (https://developers.openai.com/api/docs/pricing):
//  - the model is IMAGE_MODEL, `gpt-image-2.6-flare`. The deprecations page
//    lists gpt-image-1-mini, gpt-image-1.5 and chatgpt-image-latest as
//    shutting down Dec 1, 2026 (announced Jun 2, 2026), and gpt-image-2 on
//    Feb 10, 2027, all with "gpt-image-2.6-sunburst or gpt-image-2.6-flare"
//    as the replacement. The guide calls Flare the one "for fast,
//    high-quality everyday image generation" (Sunburst is for precise
//    edits), and both cost the same: $30 per 1M image output tokens, $5 per
//    1M text input tokens. gpt-image-2.5-* isn't listed as deprecated yet,
//    costs the same, and is a generation older;
//  - price per image: there is no per-image figure for 2.6. The guide's
//    calculator is interactive, and its only fixed figures are for older
//    models (gpt-image-2 low, 1024x1024: $0.006, at the same $30 per 1M
//    output tokens). The estimate is therefore about $0.006 per image plus
//    under $0.001 of prompt, ~$0.007 a word. `usage` comes back with each
//    image and its output tokens are logged (no prompt, no key), so the real
//    figure shows on the first real draw;
//  - `quality: "low"`: the API reference lists low/medium/high/auto for
//    GPT image models (its xhigh and max are named only for the
//    gpt-image-2.5 models, not 2.6);
//  - `complexity: "low"`: the guide's 2.6 section says Sunburst and Flare
//    take low, medium or high, default high (planning compute a single
//    plain cartoon doesn't need; the pages don't say it changes the
//    price), and the reference lists the parameter on the endpoint. No doc
//    page explicitly confirms it on /v1/images/generations for
//    gpt-image-2.6-flare: the first real draw settles it. If it is
//    refused, the 400 is logged with its status, type, code and the
//    parameter's name (below), never the prompt; drop it from
//    OPENAI_IMAGE then;
//  - `size: "1024x1024"`, the square the guide recommends for 2.6. Smaller
//    sizes are below its 655,360-pixel minimum, so the file is kept small
//    by its format instead: WebP (`output_format`, png/jpeg/webp) at
//    `output_compression` 70 (0-100, JPEG and WebP only), and the page draws
//    it at a tap target's size;
//  - `background: "auto"`, the default. The reference confirms opaque and
//    transparent only for gpt-image-2.5-* and gpt-image-2, not for 2.6, so
//    nothing unconfirmed is sent (the game's tiles have their own
//    background);
//  - `moderation: "auto"`, the default and the stricter of auto and low:
//    these are for children. A refusal is an error with
//    `type: "image_generation_user_error"` and `code: "moderation_blocked"`
//    (`content_policy_violation` on older models). The guide says not to
//    retry it unchanged, so that word is `failed` and never retried by
//    itself;
//  - GPT image models always answer base64 (`data[0].b64_json`).
// OpenAI has no seed: it gets the theme's lines but not its look, so its
// pictures are recorded as "<theme>+openai" (pictures.mjs drawnTheme).
//
// The keys are BFL_API_KEY and OPENAI_API_KEY in the gitignored .env.local
// (or the shell), read per call like the voice keys; each goes only into
// its provider's request header, never into a log line, a reply or the
// browser.
//
// LINGO_IMAGE_PROVIDER=stub draws a plain coloured square instead, with no
// network and no key: for a scratch dev server and the browser check, never
// for real use (the game then shows coloured squares).

/** The provider refused to draw this description (its moderation). */
export class ImageRefused extends Error {}
/** The call failed for another reason (network, a limit, a bad key, a
 *  server error): the word stays pending, the run stops and waits.
 *  `status` is the provider's HTTP status when it answered one (402: out
 *  of credits, 429: too many requests): the stock CLI stops on those. */
export class ImageFailed extends Error {
  status: number | null;
  /** The failure is this prompt's, not the service's or the account's (a
   *  task that ended with no picture, a server error for this request):
   *  pictures.ts counts these per word and gives up on a word after
   *  PICTURE_WORD_FAILURES in a row, so one bad word can't hold up the
   *  rest. Out of credits, a rate limit, a bad key, the network: false. */
  perWord: boolean;
  constructor(message: string, status: number | null = null, perWord = false) {
    super(message);
    this.status = status;
    this.perWord = perWord;
  }
}

/** What a provider drew: the bytes, their type (sniffed, not taken from
 *  the provider's word), and the credits it billed when it says so. */
export interface DrawnImage {
  bytes: Buffer;
  type: string;
  credits?: number | null;
}

export interface ImageProvider {
  /** "bfl", "openai", "stub", or "none" (no key): what pictures.mjs
   *  drawnTheme records a picture's theme by. */
  key: "bfl" | "openai" | "stub" | "none";
  name: string;
  /** Why it can't draw (no key), or null. Read per call: adding a key
   *  needs no restart. A sentence for the grown-up, naming no secret. */
  problem(): string | null;
  /** One picture for `prompt`: the image bytes and their type (sniffed, not
   *  taken from the provider's word). */
  draw(prompt: string, signal?: AbortSignal): Promise<DrawnImage>;
}

/** The image model (see above): change it here only. */
export const IMAGE_MODEL = "gpt-image-2.6-flare";

/** The model, size and tier asked for (one place to change them). */
export const OPENAI_IMAGE = {
  url: "https://api.openai.com/v1/images/generations",
  model: IMAGE_MODEL,
  size: "1024x1024",
  quality: "low",
  complexity: "low",
  output_format: "webp",
  output_compression: 70,
  background: "auto",
  moderation: "auto",
} as const;
const TIMEOUT_MS = 120_000;

/** An error field fit for a log line: a short identifier (an error code, a
 *  type, a parameter's name), else "". Never free text that could carry
 *  the prompt. */
const safeToken = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(v) ? v : "");

const openai: ImageProvider = {
  key: "openai",
  name: "OpenAI",
  problem: () => (voiceKeys().openai ? null : NO_KEY),
  async draw(prompt, signal) {
    const key = voiceKeys().openai;
    if (!key) throw new ImageFailed("no OpenAI key");
    const { url, ...params } = OPENAI_IMAGE;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, prompt, n: 1 }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new ImageFailed(timeout.aborted ? `OpenAI gave no answer in ${TIMEOUT_MS / 1000}s` : `OpenAI could not be reached: ${String((e as Error)?.message || e)}`);
    }
    const text = await res.text().catch(() => "");
    let body: { data?: { b64_json?: string }[]; usage?: { output_tokens?: number }; error?: { code?: string; type?: string; param?: string; message?: string } } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code = safeToken(body.error?.code);
      // Only the status, type, code and the parameter's name: the message
      // can quote the prompt, so it is never logged.
      if (code === "moderation_blocked" || code === "content_policy_violation") throw new ImageRefused(`OpenAI refused it (${code})`);
      const type = safeToken(body.error?.type);
      const param = safeToken(body.error?.param);
      const hint =
        res.status === 401 ? " (check OPENAI_API_KEY)"
        : res.status === 400 && param ? ` (the request's "${param}" was refused: a parameter or value ${IMAGE_MODEL} doesn't take? see OPENAI_IMAGE in imageProvider.ts)`
        : res.status === 400 ? ` (a bad request: check OPENAI_IMAGE in imageProvider.ts against ${IMAGE_MODEL})`
        : "";
      // A 5xx is counted against the word (OpenAI answers one for a prompt
      // it can't draw); a 4xx is the request's or the account's.
      throw new ImageFailed(`OpenAI answered ${res.status}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""}${param ? ` param=${param}` : ""}${hint}`, res.status, res.status >= 500);
    }
    // The tokens billed, for the cost (no prompt, no key in the line).
    const tokens = body.usage?.output_tokens;
    if (typeof tokens === "number") console.log(`[lingo-dojo] pictures: ${IMAGE_MODEL} image, ${tokens} output tokens`);
    const b64 = body.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new ImageRefused("OpenAI sent no image");
    const bytes = Buffer.from(b64, "base64");
    const type = sniffPicture(bytes);
    if (!type || bytes.length > MAX_PICTURE_BYTES) throw new ImageRefused("OpenAI's image wasn't a picture the app keeps");
    return { bytes, type };
  },
};

/* ---------------------------- Black Forest Labs ----------------------------- */

/** The model and settings asked for (one place to change them). */
export const BFL_IMAGE = {
  url: "https://api.bfl.ai/v1/flux-3-image-klein",
  model: "flux-3-image-klein",
  resolution: "768sq",
  output_format: "jpeg",
  safety_tolerance: 0,
} as const;
/** Measured: the credits one picture costs (1 credit = $0.01). For the
 *  stock CLI's estimate only; the real figure is each submit's `cost`. */
export const BFL_CREDITS_PER_IMAGE = 0.8;
/** The whole draw's budget (submit, polls, download) and the poll gap.
 *  Mutable for the tests. */
export const BFL_TIMING = { totalMs: 60_000, pollMs: 500 };

/** The task statuses a poll may answer (get_result's enum). */
const BFL_WAITING = new Set(["Pending", "Reasoning", "Generating"]);
const BFL_REFUSED = new Set(["Request Moderated", "Content Moderated"]);
const BFL_STATUSES = new Set([...BFL_WAITING, ...BFL_REFUSED, "Task not found", "No Card Generated", "Ready", "Error"]);

/** A URL BFL handed back, as a URL the app may fetch: https, no
 *  credentials in it, and (when `bflOnly`, for a URL the key goes to) a host
 *  on bfl.ai's own subdomains. Null otherwise: nothing is sent there. */
export function bflUrl(v: unknown, { bflOnly = true } = {}): URL | null {
  if (typeof v !== "string") return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (bflOnly && !u.hostname.toLowerCase().endsWith(".bfl.ai")) return null;
  return u;
}

/** Every request to BFL: no redirect is ever followed (a 3xx is a failed
 *  request). fetch drops `authorization` on a cross-site redirect but
 *  keeps `x-key`, so following one could hand the key to another host;
 *  and the download must not be bounced to an internal address. */
export function bflFetch(url: URL | string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

/** A body read with a size cap: null past `max` (the download is cut). */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) return null;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

const bflJson = async (res: Response): Promise<Record<string, unknown>> => {
  try {
    const v = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Why BFL refused a request, for the log: the status and a fixed reason,
 *  never the body (a 422's detail can quote the prompt). */
function bflHttpError(status: number, when: string): ImageFailed {
  const why =
    status === 402 ? "out of credits: add credits in the Black Forest Labs dashboard"
    : status === 429 ? "too many requests at once for the account (24 active tasks at most); waiting before trying again"
    : status === 401 || status === 403 ? "the key was refused: check BFL_API_KEY"
    : status === 422 ? `a request field was refused: check BFL_IMAGE in imageProvider.ts against ${BFL_IMAGE.model}`
    : "a server error";
  return new ImageFailed(`Black Forest Labs answered ${status} ${when} (${why})`, status);
}

const bfl: ImageProvider = {
  key: "bfl",
  name: "Black Forest Labs",
  problem: () => (voiceKeys().bfl ? null : NO_KEY),
  async draw(prompt, signal) {
    const key = voiceKeys().bfl;
    if (!key) throw new ImageFailed("no Black Forest Labs key");
    const deadline = AbortSignal.timeout(BFL_TIMING.totalMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const failed = (what: string, e: unknown) =>
      new ImageFailed(deadline.aborted ? `Black Forest Labs gave no picture in ${BFL_TIMING.totalMs / 1000}s` : `Black Forest Labs could not be reached (${what}): ${String((e as Error)?.message || e)}`);
    const { url, model: _model, ...params } = BFL_IMAGE;

    // Submit.
    let res: Response;
    try {
      res = await bflFetch(url, {
        method: "POST",
        headers: { "x-key": key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ prompt, ...params, seed: PICTURE_THEME.seed }),
        signal: sig,
      });
    } catch (e) {
      throw failed("submit", e);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw bflHttpError(res.status, "to the picture request");
    }
    const task = await bflJson(res);
    const credits = typeof task.cost === "number" && Number.isFinite(task.cost) ? task.cost : null;
    // The model and the credits billed, for the cost (no prompt, no key).
    console.log(`[lingo-dojo] pictures: ${BFL_IMAGE.model} image, ${credits ?? "?"} credits`);
    const poll = bflUrl(task.polling_url);
    if (!poll) throw new ImageFailed("Black Forest Labs' polling address isn't https on bfl.ai; the key wasn't sent there");

    // Poll until Ready (or a refusal, an error, the deadline).
    let sample: URL | null = null;
    while (!sample) {
      try {
        await sleep(BFL_TIMING.pollMs, undefined, { signal: sig });
        res = await bflFetch(poll, { headers: { "x-key": key, Accept: "application/json" }, signal: sig });
      } catch (e) {
        throw failed("poll", e);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw bflHttpError(res.status, "to a poll");
      }
      const got = await bflJson(res);
      const status = typeof got.status === "string" && BFL_STATUSES.has(got.status) ? got.status : "an unknown status";
      if (BFL_WAITING.has(status)) continue;
      if (BFL_REFUSED.has(status)) throw new ImageRefused(`Black Forest Labs refused it (${status})`);
      if (status !== "Ready") throw new ImageFailed(`Black Forest Labs' task ended with ${status}`, null, true);
      const result = got.result as { sample?: unknown } | null | undefined;
      sample = bflUrl(result?.sample);
      if (!sample) throw new ImageFailed("Black Forest Labs' picture address isn't https on bfl.ai; nothing was fetched");
    }

    // Download (no key: a signed URL, valid about 10 minutes).
    let bytes: Buffer | null;
    try {
      res = await bflFetch(sample, { signal: sig });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new ImageFailed(`Black Forest Labs' picture download answered ${res.status}`);
      }
      bytes = await readCapped(res, MAX_PICTURE_BYTES);
    } catch (e) {
      if (e instanceof ImageFailed) throw e;
      throw failed("download", e);
    }
    const type = bytes ? sniffPicture(bytes) : null;
    if (!bytes || !type) throw new ImageFailed("Black Forest Labs' picture wasn't a picture the app keeps (too big, or not JPEG or PNG)", null, true);
    return { bytes, type, credits };
  },
};

/** No key at all: nothing can be drawn (the stock set still works). */
const NO_KEY = "Pictures need an image key: add BFL_API_KEY (Black Forest Labs) or OPENAI_API_KEY to .env.local in the app's folder, then press Draw pictures.";
const none: ImageProvider = {
  key: "none",
  name: "no image provider",
  problem: () => NO_KEY,
  async draw() {
    throw new ImageFailed("no image key");
  },
};

/* ----------------------------------- stub ----------------------------------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A `size`-square PNG of one colour with a lighter disc in the middle:
 *  the stub's picture (and the tests'). */
export function placeholderPng(rgb: [number, number, number], size = 64): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows: Buffer[] = [];
  const r = size / 3;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < r * r;
      const px = inside ? rgb.map((v) => Math.round(v + (255 - v) * 0.6)) : rgb;
      row.set(px, 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const stub: ImageProvider = {
  key: "stub",
  name: "stub",
  problem: () => null,
  async draw(prompt) {
    // A colour from the prompt, so each word's square differs.
    const h = createHash("sha256").update(prompt).digest();
    return { bytes: placeholderPng([h[0] & 0xbf, h[1] & 0xbf, h[2] & 0xbf], 128), type: "image/png" };
  },
};

/** The provider in use, read per call (adding a key needs no restart):
 *  the stub when LINGO_IMAGE_PROVIDER=stub, else Black Forest Labs when its
 *  key is set, else OpenAI when its key is, else none. */
export function imageProvider(): ImageProvider {
  if (process.env.LINGO_IMAGE_PROVIDER === "stub") return stub;
  const keys = voiceKeys();
  return keys.bfl ? bfl : keys.openai ? openai : none;
}

/** Black Forest Labs whatever other key is set, for the stock CLI (the
 *  stock set is drawn in the theme's own provider); its problem() says
 *  when there is no BFL_API_KEY. */
export const bflProvider = (): ImageProvider => bfl;

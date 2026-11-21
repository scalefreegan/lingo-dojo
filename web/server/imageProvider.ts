import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { sniffPicture, MAX_PICTURE_BYTES } from "../../scripts/picture-store.mjs";
import { voiceKeys } from "../../scripts/voice.mjs";

// The image provider behind the kids word game's pictures (docs/DATA.md §Kids
// word game), in one small module so another can be swapped in: the rest of
// the server sees only `imageProvider()` → { name, problem(), draw(prompt) }.
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
// The key is OPENAI_API_KEY in the gitignored .env.local (or the shell),
// read per call like the voice keys; it goes only into the request's
// Authorization header, never into a log line, a reply or the browser.
//
// LINGO_IMAGE_PROVIDER=stub draws a plain coloured square instead, with no
// network and no key: for a scratch dev server and the browser check, never
// for real use (the game then shows coloured squares).

/** The provider refused to draw this description (its moderation). */
export class ImageRefused extends Error {}
/** The call failed for another reason (network, a limit, a bad key, a
 *  server error): the word stays pending, the run stops and waits. */
export class ImageFailed extends Error {}

export interface ImageProvider {
  name: string;
  /** Why it can't draw (no key), or null. Read per call: adding a key
   *  needs no restart. A sentence for the grown-up, naming no secret. */
  problem(): string | null;
  /** One picture for `prompt`: the image bytes and their type (sniffed, not
   *  taken from the provider's word). */
  draw(prompt: string, signal?: AbortSignal): Promise<{ bytes: Buffer; type: string }>;
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
  name: "OpenAI",
  problem: () => (voiceKeys().openai ? null : "Pictures need an OpenAI key: add OPENAI_API_KEY to .env.local in the app's folder, then press Draw pictures."),
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
    let body: { data?: { b64_json?: string }[]; usage?: { output_tokens?: number }; error?: { code?: string; type?: string; message?: string } } = {};
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
      throw new ImageFailed(`OpenAI answered ${res.status}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""}${param ? ` param=${param}` : ""}${hint}`);
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
  name: "stub",
  problem: () => null,
  async draw(prompt) {
    // A colour from the prompt, so each word's square differs.
    const h = createHash("sha256").update(prompt).digest();
    return { bytes: placeholderPng([h[0] & 0xbf, h[1] & 0xbf, h[2] & 0xbf], 128), type: "image/png" };
  },
};

/** The provider in use: OpenAI, or the stub when LINGO_IMAGE_PROVIDER=stub. */
export function imageProvider(): ImageProvider {
  return process.env.LINGO_IMAGE_PROVIDER === "stub" ? stub : openai;
}

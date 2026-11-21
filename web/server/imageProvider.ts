import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { sniffPicture, MAX_PICTURE_BYTES } from "../../scripts/picture-store.mjs";
import { voiceKeys } from "../../scripts/voice.mjs";

// The image provider behind the kids word game's pictures (docs/DATA.md §Kids
// word game), in one small module so another can be swapped in: the rest of
// the server sees only `imageProvider()` → { name, problem(), draw(prompt) }.
//
// OpenAI Images (POST /v1/images/generations), checked against OpenAI's
// API reference and image generation guide on 2026-11-20
// (developers.openai.com/api/reference/resources/images,
// /api/docs/guides/image-generation, /api/docs/pricing):
//  - the GPT image models always answer base64 (`data[0].b64_json`); there
//    is no URL to fetch;
//  - `gpt-image-1-mini` is the cheapest model; at `quality: "low"` and
//    1024x1024 it is listed at about $0.005 an image ($0.011 medium);
//  - the smallest square size the GPT image models take is 1024x1024 (256
//    and 512 are DALL·E 2's), so the size is bounded by the format instead:
//    WebP at compression 70, a few tens of KB, and the page draws it at a
//    tap target's size;
//  - `moderation: "auto"` (the stricter default) stays: these are for
//    children. A refusal comes back as an error whose code is
//    `moderation_blocked` (or `content_policy_violation` on older models):
//    that word is `failed` and never retried by itself.
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

/** The model, size and tier asked for (one place to change them). */
export const OPENAI_IMAGE = {
  url: "https://api.openai.com/v1/images/generations",
  model: "gpt-image-1-mini",
  size: "1024x1024",
  quality: "low",
  output_format: "webp",
  output_compression: 70,
  background: "opaque",
  moderation: "auto",
} as const;
const TIMEOUT_MS = 120_000;

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
    let body: { data?: { b64_json?: string }[]; error?: { code?: string; type?: string; message?: string } } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code = String(body.error?.code ?? "");
      // Only the code and status: the message can quote the prompt.
      if (code === "moderation_blocked" || code === "content_policy_violation") throw new ImageRefused(`OpenAI refused it (${code})`);
      const hint = res.status === 401 ? " (check OPENAI_API_KEY)" : "";
      throw new ImageFailed(`OpenAI answered ${res.status}${code ? ` ${code}` : ""}${hint}`);
    }
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

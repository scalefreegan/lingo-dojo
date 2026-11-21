/* The recorder's 16 kHz conversion, in a Worker (wavConverter.ts says why).
 * Each message is one recording's mono samples, transferred; the reply is
 * its WAV file, transferred back. */

import { answerWavRequest, type WavRequest } from "./wav16k.ts";

self.onmessage = (e: MessageEvent<WavRequest>) => {
  const reply = answerWavRequest(e.data);
  self.postMessage(reply, { transfer: "wav" in reply ? [reply.wav] : [] });
};

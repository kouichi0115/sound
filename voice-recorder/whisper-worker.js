// 端末内で Whisper を動かして文字起こしするワーカー。
// メインスレッドから 16kHz モノラルの Float32Array をブロック単位で受け取る。
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";

let asr = null;
let loadedModel = null;

async function load(model) {
  if (asr && loadedModel === model) return asr;
  asr = await pipeline("automatic-speech-recognition", model, {
    progress_callback: (p) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        self.postMessage({ type: "load", file: p.file, progress: p.progress });
      }
    },
  });
  loadedModel = model;
  return asr;
}

self.onmessage = async (e) => {
  const { id, model, language, audio } = e.data;
  try {
    const run = await load(model);
    const out = await run(audio, {
      language,
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    self.postMessage({ type: "result", id, chunks: out.chunks || [], text: out.text || "" });
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message || String(err) });
  }
};

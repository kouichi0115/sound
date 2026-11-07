// コエメモ: 録音 → 文字起こし（タイムスタンプ付き）→ 要約 → ドキュメント出力
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const ANTHROPIC_SDK = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm";
const LANGS = {
  ja: { speech: "ja-JP", whisper: "japanese", label: "日本語" },
  en: { speech: "en-US", whisper: "english", label: "英語" },
  zh: { speech: "zh-CN", whisper: "chinese", label: "中国語" },
  ko: { speech: "ko-KR", whisper: "korean", label: "韓国語" },
};

// ---------- 小物 ----------
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function srtTime(sec) {
  const ms = Math.round((sec || 0) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}
function parseTs(str) {
  const parts = str.split(":").map(Number);
  return parts.reduce((a, b) => a * 60 + b, 0);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const lang = () => LANGS[store.get("koememo.lang", "ja")] || LANGS.ja;
const dateLabel = (t) => new Date(t).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// ---------- IndexedDB ----------
const db = {
  _p: null,
  open() {
    this._p ??= new Promise((res, rej) => {
      const r = indexedDB.open("koememo", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("records", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction("records", mode);
      const req = fn(t.objectStore("records"));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  },
  put: (r) => db.tx("readwrite", (s) => s.put(r)),
  del: (id) => db.tx("readwrite", (s) => s.delete(id)),
  all: () => db.tx("readonly", (s) => s.getAll()),
};

// ---------- 状態 ----------
let current = null; // { id, title, createdAt, duration, mime, blob, segments, summary, summaryKind }
let audioUrl = null;

async function save() {
  if (!current) return;
  try { await db.put(current); } catch (e) { console.error(e); toast("保存に失敗しました（ストレージ容量を確認してください）"); }
  renderHistory();
}

// ---------- 録音 ----------
const rec = { mr: null, stream: null, chunks: [], acc: 0, since: 0, paused: false, ctx: null, raf: 0, timer: 0, recog: null, segments: [] };
const elapsed = () => (rec.acc + (rec.paused || !rec.since ? 0 : performance.now() - rec.since)) / 1000;
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("このブラウザは録音に対応していません");
    return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast("マイクの使用が許可されませんでした");
    return;
  }
  const mime = pickMime();
  rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = [];
  rec.segments = [];
  rec.acc = 0;
  rec.paused = false;
  rec.since = performance.now();
  rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.mr.onstop = finishRecording;
  rec.mr.start(1000);

  startMeter(rec.stream);
  rec.timer = setInterval(() => ($("#timer").textContent = fmt(elapsed())), 250);
  $("#recBtn").classList.add("recording");
  $("#recBtn").setAttribute("aria-label", "録音停止");
  $("#pauseBtn").disabled = false;
  $("#pauseBtn").textContent = "一時停止";

  // 新規セッション表示（ライブ文字起こし用）
  openSession({ id: crypto.randomUUID(), title: `録音 ${dateLabel(Date.now())}`, createdAt: Date.now(), duration: 0, segments: rec.segments, summary: "" }, true);
  if ($("#liveToggle").checked && SpeechRec) startRecognition();
}

function togglePause() {
  if (!rec.mr) return;
  if (!rec.paused) {
    rec.mr.pause();
    rec.acc += performance.now() - rec.since;
    rec.paused = true;
    rec.recog?.stop();
    $("#pauseBtn").textContent = "再開";
  } else {
    rec.mr.resume();
    rec.since = performance.now();
    rec.paused = false;
    if (rec.recog) startRecognition();
    $("#pauseBtn").textContent = "一時停止";
  }
}

function stopRecording() {
  if (!rec.mr) return;
  if (!rec.paused) rec.acc += performance.now() - rec.since;
  rec.paused = true;
  const r = rec.recog;
  rec.recog = null;
  r?.stop();
  rec.mr.stop();
  rec.stream.getTracks().forEach((t) => t.stop());
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ctx?.close();
  $("#recBtn").classList.remove("recording");
  $("#recBtn").setAttribute("aria-label", "録音開始");
  $("#pauseBtn").disabled = true;
  $("#liveLine").classList.add("hidden");
}

async function finishRecording() {
  const blob = new Blob(rec.chunks, { type: rec.mr.mimeType || "audio/webm" });
  current.blob = blob;
  current.mime = blob.type;
  current.duration = rec.acc / 1000;
  current.segments = rec.segments;
  rec.mr = null;
  $("#whisperBtn").disabled = false;
  setPlayer(blob);
  renderMeta();
  renderSegments();
  await save();
  toast(current.segments.length ? "録音を保存しました" : "録音を保存しました。「高精度で文字起こし」で文字にできます");
}

function startMeter(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  rec.ctx = ctx;
  const cv = $("#meter"), g = cv.getContext("2d");
  const buf = new Uint8Array(an.fftSize);
  const hist = [];
  const color = getComputedStyle(document.documentElement).getPropertyValue("--rec").trim() || "#d6453d";
  const draw = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    hist.push(rec.paused ? 0 : Math.min(1, Math.sqrt(sum / buf.length) * 4));
    if (hist.length > 120) hist.shift();
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = color;
    const w = cv.width / 120;
    hist.forEach((v, i) => {
      const h = Math.max(2, v * cv.height);
      g.fillRect(i * w, (cv.height - h) / 2, w - 1, h);
    });
    rec.raf = requestAnimationFrame(draw);
  };
  draw();
}

// ブラウザ音声認識でリアルタイム文字起こし（発話の開始時刻をタイムスタンプにする）
function startRecognition() {
  const r = new SpeechRec();
  r.lang = lang().speech;
  r.continuous = true;
  r.interimResults = true;
  const starts = {};
  const done = new Set();
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      starts[i] ??= Math.max(0, elapsed() - 1.0);
      if (res.isFinal) {
        if (done.has(i)) continue;
        done.add(i);
        const text = res[0].transcript.trim();
        if (text) {
          rec.segments.push({ start: starts[i], end: elapsed(), text });
          renderSegments();
        }
      } else {
        interim += res[0].transcript;
      }
    }
    const line = $("#liveLine");
    line.textContent = interim ? `${fmt(elapsed())}  ${interim}` : "";
    line.classList.toggle("hidden", !interim);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("リアルタイム文字起こしが使えません。録音後に「高精度で文字起こし」を使ってください");
      rec.recog = null;
    }
  };
  // 無音などで自動終了するので、録音中は再開する
  r.onend = () => { if (rec.recog === r && !rec.paused) { try { r.start(); } catch {} } };
  rec.recog = r;
  try { r.start(); } catch {}
}

// ---------- ファイル読み込み ----------
async function importFile(file) {
  if (!file) return;
  const rec0 = {
    id: crypto.randomUUID(),
    title: file.name.replace(/\.[^.]+$/, ""),
    createdAt: Date.now(),
    duration: 0,
    mime: file.type,
    blob: file,
    segments: [],
    summary: "",
  };
  openSession(rec0);
  current.duration = await probeDuration(file);
  renderMeta();
  await save();
  toast("読み込みました。「高精度で文字起こし」を押してください");
}
function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => {
      if (a.duration === Infinity) { // webm 対策
        a.currentTime = 1e9;
        a.ontimeupdate = () => { a.ontimeupdate = null; res(a.duration); URL.revokeObjectURL(a.src); };
      } else { res(a.duration || 0); URL.revokeObjectURL(a.src); }
    };
    a.onerror = () => res(0);
    a.src = URL.createObjectURL(blob);
  });
}

// ---------- Whisper（端末内・高精度） ----------
let worker = null;
function getWorker() {
  worker ??= new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
  return worker;
}
function workerRun(payload, onLoad) {
  return new Promise((res, rej) => {
    const w = getWorker();
    const id = Math.random().toString(36).slice(2);
    const h = (e) => {
      const m = e.data;
      if (m.type === "load") return onLoad?.(m);
      if (m.id !== id) return;
      w.removeEventListener("message", h);
      w.removeEventListener("error", fail);
      m.type === "result" ? res(m) : rej(new Error(m.message));
    };
    // ワーカー自体の読み込み失敗（オフライン等）で固まらないようにする
    const fail = (e) => {
      w.removeEventListener("message", h);
      w.terminate();
      worker = null;
      rej(new Error(e?.message || "文字起こしエンジンを読み込めませんでした（ネットワークを確認してください）"));
    };
    w.addEventListener("message", h);
    w.addEventListener("error", fail, { once: true });
    w.postMessage({ ...payload, id }, [payload.audio.buffer]);
  });
}

async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  const len = Math.ceil(decoded.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

// 約2分ごとに、境界付近の一番静かな位置で区切る
function splitBlocks(audio, sr = 16000, target = 120, search = 10) {
  const blocks = [];
  let pos = 0;
  while (pos < audio.length) {
    let end = Math.min(audio.length, pos + target * sr);
    if (end < audio.length) {
      const win = Math.floor(0.25 * sr);
      let best = end, bestE = Infinity;
      for (let s = end - search * sr; s + win < end + win && s + win < audio.length; s += win) {
        let e = 0;
        for (let i = s; i < s + win; i++) e += audio[i] * audio[i];
        if (e < bestE) { bestE = e; best = s + Math.floor(win / 2); }
      }
      end = best;
    }
    blocks.push({ start: pos / sr, data: audio.slice(pos, end) });
    pos = end;
  }
  return blocks;
}

async function runWhisper() {
  if (!current?.blob) return toast("音声がありません");
  if (current.segments.length && !confirm("今の文字起こしを置き換えます。よろしいですか？")) return;
  const btn = $("#whisperBtn");
  const bar = $("#whisperProgress");
  const setBar = (pct, label) => {
    bar.classList.remove("hidden");
    bar.querySelector("div").style.width = `${pct}%`;
    bar.querySelector("span").textContent = label;
  };
  btn.disabled = true;
  const target = current;
  try {
    setBar(0, "音声を準備中…");
    const audio = await decodeTo16k(target.blob);
    if (!target.duration) target.duration = audio.length / 16000;
    const blocks = splitBlocks(audio);
    const model = $("#whisperModel").value;
    const segs = [];
    for (let b = 0; b < blocks.length; b++) {
      const { start, data } = blocks[b];
      const base = (b / blocks.length) * 100;
      setBar(base, b === 0 ? "モデルを読み込み中…" : `文字起こし中… ${fmt(start)} / ${fmt(target.duration)}`);
      const out = await workerRun(
        { model, language: lang().whisper, audio: data },
        (m) => setBar(m.progress, `モデルをダウンロード中… ${Math.round(m.progress)}%`),
      );
      const blockEnd = start + data.length / 16000;
      for (const c of out.chunks) {
        const text = (c.text || "").trim();
        if (!text) continue;
        const [s, e] = c.timestamp || [];
        segs.push({ start: start + (s ?? 0), end: e != null ? start + e : blockEnd, text });
      }
      if (current === target) { target.segments = [...segs]; renderSegments(); }
      setBar(((b + 1) / blocks.length) * 100, `文字起こし中… ${fmt(blockEnd)} / ${fmt(target.duration)}`);
    }
    target.segments = segs;
    target.transcriber = model;
    if (current === target) { renderSegments(); renderMeta(); }
    await db.put(target);
    renderHistory();
    toast("文字起こしが完了しました");
  } catch (e) {
    console.error(e);
    toast(`文字起こしに失敗しました: ${e.message}`, 5000);
  } finally {
    btn.disabled = false;
    setTimeout(() => bar.classList.add("hidden"), 800);
  }
}

// ---------- 要約 ----------
const STYLE_PROMPTS = {
  meeting: "会議・打ち合わせの議事録として、「概要」「主な議題と要点」「決定事項」「ToDo（担当・期限が分かれば記載）」「未解決の論点」の見出しで整理してください。",
  lecture: "講義・セミナーのノートとして、「概要」「重要なポイント」「キーワード解説」「復習のための問い」の見出しで整理してください。",
  interview: "インタビュー記録として、「概要」「話し手の主な主張」「印象的な発言（引用）」「次に深掘りすべき点」の見出しで整理してください。",
  memo: "個人のボイスメモとして、「概要」「アイデア・気づき」「やること」の見出しで整理してください。",
};

function transcriptText(r = current) {
  return r.segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join("\n");
}

async function summarize() {
  if (!current?.segments.length) return toast("先に文字起こしをしてください");
  const key = store.get("koememo.apiKey");
  const target = current;
  const btn = $("#summarizeBtn");
  btn.disabled = true;
  try {
    if (!key) {
      target.summary = localSummary(target);
      target.summaryKind = "local";
    } else {
      target.summary = await claudeSummary(target, key, (text) => {
        if (current === target) renderSummary(text);
      });
      target.summaryKind = "claude";
    }
    if (current === target) renderSummary();
    await db.put(target);
    toast("要約ができました");
  } catch (e) {
    console.error(e);
    toast(e.userMessage || `要約に失敗しました: ${e.message}`, 5000);
  } finally {
    btn.disabled = false;
  }
}

async function claudeSummary(r, apiKey, onText) {
  const sdk = await import(ANTHROPIC_SDK);
  const Anthropic = sdk.default;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const style = $("#summaryStyle").value;
  const system =
    "あなたは録音の文字起こしから読みやすい要約ドキュメントを作るアシスタントです。" +
    "文字起こしには音声認識の誤りが含まれることがあるので、文脈から自然に補って解釈してください。" +
    "出力は日本語の Markdown（見出しは ## 、箇条書きは - ）のみとし、前置きや締めの挨拶は書かないでください。" +
    "各要点の末尾には、根拠となる発言の時刻を [mm:ss] 形式（1時間以上なら [h:mm:ss]）で必ず付けてください。";
  const user =
    `タイトル: ${r.title}\n録音時間: ${fmt(r.duration)}\n\n${STYLE_PROMPTS[style]}\n\n` +
    `<transcript>\n${transcriptText(r)}\n</transcript>`;

  let text = "";
  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
    });
    stream.on("text", (delta) => { text += delta; onText(text); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      const err = new Error("refusal");
      err.userMessage = "この内容は要約できませんでした";
      throw err;
    }
    if (msg.stop_reason === "max_tokens") text += "\n\n（※ 長すぎるため途中で終了しました）";
    return text.trim();
  } catch (e) {
    if (e.userMessage) throw e;
    if (e instanceof sdk.AuthenticationError) e.userMessage = "APIキーが正しくありません（⚙ 設定で確認してください）";
    else if (e instanceof sdk.RateLimitError) e.userMessage = "混み合っています。少し待ってから再度お試しください";
    else if (e instanceof sdk.APIConnectionError) e.userMessage = "通信に失敗しました。ネットワークを確認してください";
    throw e;
  }
}

// APIキーなしでも使える簡易要約（重要そうな発言を抜き出す）
function localSummary(r) {
  const segs = r.segments.filter((s) => s.text.length > 4);
  if (!segs.length) return "## 概要\n\n要約できる内容がありませんでした。";
  const grams = (t) => {
    const s = t.replace(/[\s、。！？!?,.「」『』（）()]/g, "");
    const g = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
    return g;
  };
  const freq = new Map();
  segs.forEach((s) => new Set(grams(s.text)).forEach((g) => freq.set(g, (freq.get(g) || 0) + 1)));
  const scored = segs.map((s, i) => {
    const g = grams(s.text);
    const score = g.reduce((a, x) => a + Math.log(1 + (freq.get(x) || 0)), 0) / Math.sqrt(g.length || 1);
    return { s, i, score };
  });
  const n = Math.min(8, Math.max(3, Math.round(segs.length / 6)));
  const top = scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i);
  return (
    `## 概要\n\n- 録音時間 ${fmt(r.duration)}、発言 ${r.segments.length} 件\n\n` +
    `## 主な発言\n\n${top.map(({ s }) => `- ${s.text} [${fmt(s.start)}]`).join("\n")}\n\n` +
    `> 簡易要約（端末内）です。⚙ 設定で Claude API キーを入れると、AI による詳しい要約になります。`
  );
}

// 最小限の Markdown 表示（[mm:ss] はクリックで再生位置へ）
function mdToHtml(md, { tsButtons = true } = {}) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(\d{1,2}(?::\d{2}){1,2})\]/g, (_, ts) =>
        tsButtons ? `<button class="ts" data-t="${parseTs(ts)}">${ts}</button>` : `[${ts}]`);
  let html = "", inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*・]\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) html += `<h${Math.min(h[1].length + 1, 4)}>${inline(h[2])}</h${Math.min(h[1].length + 1, 4)}>`;
    else if (line.startsWith(">")) html += `<p class="hint">${inline(line.replace(/^>\s?/, ""))}</p>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

// ---------- 書き出し ----------
function docParts() {
  const r = current;
  return {
    title: r.title || "無題の録音",
    meta: `録音日時: ${dateLabel(r.createdAt)}　／　長さ: ${fmt(r.duration)}`,
    summary: $("#incSummary").checked ? r.summary : "",
    segs: $("#incTranscript").checked ? r.segments : [],
  };
}
function buildMarkdown() {
  const p = docParts();
  let md = `# ${p.title}\n\n${p.meta}\n\n`;
  if (p.summary) md += `${p.summary.replace(/^#\s/gm, "## ")}\n\n`;
  if (p.segs.length) md += `## 文字起こし\n\n${p.segs.map((s) => `**[${fmt(s.start)}]** ${s.text}  `).join("\n")}\n`;
  return md;
}
function buildText() {
  const p = docParts();
  let t = `${p.title}\n${p.meta}\n\n`;
  if (p.summary) t += `■ 要約\n${p.summary.replace(/^#+\s*/gm, "").replace(/\*\*/g, "")}\n\n`;
  if (p.segs.length) t += `■ 文字起こし\n${p.segs.map((s) => `[${fmt(s.start)}] ${s.text}`).join("\n")}\n`;
  return t;
}
function buildHtml() {
  const p = docParts();
  const rows = p.segs
    .map((s) => `<tr><td class="t">${fmt(s.start)}</td><td>${esc(s.text)}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(p.title)}</title>
<style>
body{font-family:"Hiragino Sans","Yu Gothic","Meiryo",sans-serif;line-height:1.7;color:#222;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:20pt;margin-bottom:4px}h2{font-size:14pt;border-bottom:1px solid #ccc;padding-bottom:2px;margin-top:22px}
h3{font-size:12pt}.meta{color:#666;font-size:10pt}table{border-collapse:collapse;width:100%}
td{vertical-align:top;padding:4px 6px;border-bottom:1px solid #eee;font-size:10.5pt}
td.t{white-space:nowrap;color:#2f6f5e;width:70px;font-family:Consolas,monospace}.hint{color:#666;font-size:9pt}
</style></head><body>
<h1>${esc(p.title)}</h1><p class="meta">${esc(p.meta)}</p>
${p.summary ? `<h2>要約</h2>${mdToHtml(p.summary, { tsButtons: false })}` : ""}
${p.segs.length ? `<h2>文字起こし</h2><table>${rows}</table>` : ""}
</body></html>`;
}
function buildSrt() {
  return current.segments
    .map((s, i) => {
      const next = current.segments[i + 1];
      const end = Math.max(s.start + 1, Math.min(s.end ?? s.start + 3, next ? next.start : Infinity));
      return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(end)}\n${s.text}\n`;
    })
    .join("\n");
}
function download(content, name, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function safeName() {
  return (current.title || "recording").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}
function doExport(kind) {
  if (!current) return;
  const needsText = !["audio"].includes(kind);
  if (needsText && !current.segments.length && !current.summary) return toast("先に文字起こしをしてください");
  const name = safeName();
  switch (kind) {
    case "md": return download(buildMarkdown(), `${name}.md`, "text/markdown;charset=utf-8");
    case "txt": return download("﻿" + buildText(), `${name}.txt`, "text/plain;charset=utf-8");
    case "srt": return download(buildSrt(), `${name}.srt`, "application/x-subrip;charset=utf-8");
    case "docx": {
      // Word で開ける HTML 形式の文書
      const html = buildHtml().replace("<html lang=\"ja\">",
        '<html lang="ja" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">');
      return download("﻿" + html, `${name}.doc`, "application/msword;charset=utf-8");
    }
    case "pdf": {
      const w = window.open("", "_blank");
      if (!w) return toast("ポップアップを許可してください");
      w.document.write(buildHtml());
      w.document.close();
      w.onload = () => w.print();
      setTimeout(() => { try { w.print(); } catch {} }, 600);
      return;
    }
    case "audio": {
      if (!current.blob) return toast("音声がありません");
      const ext = (current.mime || "").includes("mp4") ? "m4a" : (current.mime || "").includes("ogg") ? "ogg"
        : (current.mime || "").includes("mpeg") ? "mp3" : (current.mime || "").includes("wav") ? "wav" : "webm";
      return download(current.blob, current.blob.name || `${name}.${ext}`);
    }
  }
}

// ---------- 表示 ----------
function setPlayer(blob) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = blob ? URL.createObjectURL(blob) : null;
  const p = $("#player");
  if (audioUrl) p.src = audioUrl; else p.removeAttribute("src");
  p.classList.toggle("hidden", !blob);
}

function openSession(r, live = false) {
  current = r;
  $("#sessionCard").classList.remove("hidden");
  $("#titleInput").value = r.title;
  setPlayer(live ? null : r.blob);
  $("#whisperBtn").disabled = live;
  $("#summaryStyle").value = r.summaryStyle || "meeting";
  renderMeta();
  renderSegments();
  renderSummary();
  showTab("transcript");
  renderHistory();
  if (!live) $("#sessionCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMeta() {
  if (!current) return;
  const bits = [dateLabel(current.createdAt)];
  if (current.duration) bits.push(fmt(current.duration));
  if (current.segments?.length) bits.push(`${current.segments.length} 発言`);
  $("#sessionMeta").textContent = bits.join(" ・ ");
}

function renderSegments() {
  const ol = $("#segments");
  const segs = current?.segments || [];
  ol.innerHTML = segs
    .map((s, i) => `<li data-i="${i}"><button class="ts" data-t="${s.start}">${fmt(s.start)}</button>` +
      `<span class="seg-text" contenteditable="true" spellcheck="false">${esc(s.text)}</span></li>`)
    .join("");
  $("#segEmpty").classList.toggle("hidden", segs.length > 0);
  if (rec.mr) ol.lastElementChild?.scrollIntoView({ block: "nearest" });
}

function renderSummary(streaming) {
  const box = $("#summary");
  const md = streaming ?? current?.summary ?? "";
  box.innerHTML = md ? mdToHtml(md) : '<p class="empty">まだ要約がありません。</p>';
  const hasKey = !!store.get("koememo.apiKey");
  $("#summaryHint").textContent = hasKey
    ? "文字起こしを Anthropic API（Claude）に送って要約します。"
    : "APIキー未設定のため簡易要約（端末内）になります。⚙ 設定で Claude API キーを入れると詳しい要約になります。";
  $("#summarizeBtn").textContent = hasKey ? "AIで要約" : "簡易要約";
}

async function renderHistory() {
  let all = [];
  try { all = await db.all(); } catch {}
  all.sort((a, b) => b.createdAt - a.createdAt);
  $("#history").innerHTML = all
    .map((r) => `<li data-id="${r.id}" class="${current?.id === r.id ? "active" : ""}">
      <span class="h-title">${esc(r.title || "無題")}</span>
      <span class="h-meta">${new Date(r.createdAt).toLocaleDateString("ja-JP")} ${fmt(r.duration)}${r.summary ? " ・要約" : ""}</span></li>`)
    .join("");
  $("#historyEmpty").classList.toggle("hidden", all.length > 0);
}

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${name}`));
}

function seek(t) {
  const p = $("#player");
  if (!p.src) return;
  p.currentTime = Number(t);
  p.play().catch(() => {});
}

// ---------- イベント ----------
$("#recBtn").addEventListener("click", () => (rec.mr ? stopRecording() : startRecording()));
$("#pauseBtn").addEventListener("click", togglePause);
$("#fileInput").addEventListener("change", (e) => { importFile(e.target.files[0]); e.target.value = ""; });
$("#whisperBtn").addEventListener("click", runWhisper);
$("#summarizeBtn").addEventListener("click", summarize);
$("#summaryStyle").addEventListener("change", (e) => { if (current) { current.summaryStyle = e.target.value; save(); } });
$$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$$("[data-export]").forEach((b) => b.addEventListener("click", () => doExport(b.dataset.export)));

$("#copyBtn").addEventListener("click", async () => {
  if (!current) return;
  try { await navigator.clipboard.writeText(buildText()); toast("コピーしました"); }
  catch { toast("コピーできませんでした"); }
});
$("#titleInput").addEventListener("change", (e) => { if (current) { current.title = e.target.value.trim() || "無題の録音"; if (!rec.mr) save(); } });
$("#deleteBtn").addEventListener("click", async () => {
  if (!current || rec.mr) return;
  if (!confirm("この録音を削除しますか？")) return;
  await db.del(current.id);
  current = null;
  setPlayer(null);
  $("#sessionCard").classList.add("hidden");
  renderHistory();
  toast("削除しました");
});

// タイムスタンプのクリック → 再生位置へ
document.addEventListener("click", (e) => {
  const ts = e.target.closest(".ts");
  if (ts) seek(ts.dataset.t);
});

// 文字起こしの手直し
$("#segments").addEventListener("focusout", (e) => {
  const li = e.target.closest("li");
  if (!li || !current) return;
  const i = Number(li.dataset.i);
  const text = e.target.textContent.trim();
  if (current.segments[i] && current.segments[i].text !== text) {
    current.segments[i].text = text;
    if (!rec.mr) save();
  }
});

// 再生中の発言をハイライト
$("#player").addEventListener("timeupdate", (e) => {
  const t = e.target.currentTime;
  const segs = current?.segments || [];
  let idx = -1;
  for (let i = 0; i < segs.length; i++) if (segs[i].start <= t) idx = i; else break;
  $$("#segments li").forEach((li) => li.classList.toggle("playing", Number(li.dataset.i) === idx));
});

$("#history").addEventListener("click", async (e) => {
  const li = e.target.closest("li");
  if (!li || rec.mr) return;
  const all = await db.all();
  const r = all.find((x) => x.id === li.dataset.id);
  if (r) openSession(r);
});

// 設定
$("#settingsBtn").addEventListener("click", () => {
  $("#apiKey").value = store.get("koememo.apiKey");
  $("#lang").value = store.get("koememo.lang", "ja");
  $("#settings").showModal();
});
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  store.set("koememo.apiKey", $("#apiKey").value.trim());
  store.set("koememo.lang", $("#lang").value);
  renderSummary();
  toast("保存しました");
});

window.addEventListener("beforeunload", (e) => { if (rec.mr) { e.preventDefault(); e.returnValue = ""; } });

// 初期化
$("#liveSupport").textContent = SpeechRec
  ? ""
  : "このブラウザはリアルタイム文字起こしに未対応です。録音後に「高精度で文字起こし」を使ってください。";
if (!SpeechRec) $("#liveToggle").checked = false;
renderHistory();

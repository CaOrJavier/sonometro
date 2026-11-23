import { denoise, noiseSpectrum, frameSizeFor, encodeWav, decodeWav, normalizePeak, waveformPeaks } from './dsp.js';
import * as store from './db.js';

/* ================= Utilidades ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfMax1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const fmt1 = (v) => (Number.isFinite(v) ? nf1.format(v) : '--');
const pow2db = (p) => 10 * Math.log10(p > 1e-15 ? p : 1e-15);
const amp2db = (a) => 20 * Math.log10(a > 1e-7 ? a : 1e-7);
const nextFrame = () => new Promise((r) => setTimeout(r, 30));
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(sec, hours = false) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return hours || h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function fmtDur(sec) {
  if (sec < 60) return `${nfMax1.format(Math.round(sec * 10) / 10)} s`;
  return `${fmtClock(sec)} min`;
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return `${nf0.format(Math.max(1, b / 1024))} KB`;
  return `${nf1.format(b / 1024 / 1024)} MB`;
}
const fmtDate = (d) => d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fileStamp = (d) => `${isoDate(d)}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;

function hexA(hex, a) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ================= Ajustes ================= */
const SETTINGS_KEY = 'sonometro.settings.v1';
const NOISE_KEY = 'sonometro.noise.v1';
const TAB_KEY = 'sonometro.tab';
const DEMO = new URLSearchParams(location.search).has('demo');

const DEFAULTS = {
  offset: 100,
  weighting: 'A',
  tau: 'fast',
  autoRec: false,
  threshold: 60,
  pre: 2,
  post: 2,
  minEvent: 0,
  maxDur: 60,
  normalize: false,
  hum: 0,
  humHarm: 8,
  highpass: 0,
  lowpass: 0,
  nrMode: 'off',
  nrStrength: 2,
  wakeLock: true,
  historyWin: 60,
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* nada */ } }

function loadSettings() {
  try {
    const s = JSON.parse(lsGet(SETTINGS_KEY) || '{}');
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (k in s && typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}
let settings = loadSettings();
const saveSettings = () => lsSet(SETTINGS_KEY, JSON.stringify(settings));

const tauSec = () => (settings.tau === 'slow' ? 1 : 0.125);
const unitLabel = () => (settings.weighting === 'Z' ? 'dB(Z)' : 'dB(A)');
const NR_PARAMS = { 1: { strength: 1.5, floor: 0.22 }, 2: { strength: 2.2, floor: 0.1 }, 3: { strength: 3.2, floor: 0.05 } };
const nrParams = () => NR_PARAMS[settings.nrStrength] || NR_PARAMS[2];

function getNoiseProfile(fs) {
  try {
    const p = JSON.parse(lsGet(NOISE_KEY) || 'null');
    if (!p || p.fs !== fs || p.n !== frameSizeFor(fs) || !Array.isArray(p.spec)) return null;
    return Float64Array.from(p.spec);
  } catch {
    return null;
  }
}
function getNoiseMeta() {
  try { return JSON.parse(lsGet(NOISE_KEY) || 'null'); } catch { return null; }
}

// Reducción de ruido en un Worker (si el navegador no lo admite, se hace aquí mismo)
let nrWorker = null, nrSeq = 0;
const nrPending = new Map();
function denoiseInWorker(samples, fs, noise, params) {
  if (!nrWorker) {
    nrWorker = new Worker('js/nr-worker.js', { type: 'module' });
    nrWorker.onmessage = (e) => {
      const p = nrPending.get(e.data.id);
      if (!p) return;
      nrPending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.out);
    };
    nrWorker.onerror = (e) => {
      for (const p of nrPending.values()) p.reject(e);
      nrPending.clear();
      try { nrWorker.terminate(); } catch { /* nada */ }
      nrWorker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nrSeq;
    nrPending.set(id, { resolve, reject });
    nrWorker.postMessage({ id, samples, fs, noise, params });
  });
}
async function denoiseAsync(samples, fs, noise, params) {
  try {
    return await denoiseInWorker(samples, fs, noise, params);
  } catch (e) {
    console.warn('Worker no disponible, procesando en el hilo principal', e);
    return denoise(samples, fs, { noise, ...params });
  }
}

/* ================= Estado ================= */
const A = {
  ctx: null, stream: null, source: null, worklet: null, analyser: null, sink: null,
  filters: [], demoNodes: [], running: false, starting: false, stalled: false, fs: 48000,
};
const S = { latest: null, minRaw: Infinity, maxRaw: -Infinity, peakRaw: -Infinity, energy: 0, samples: 0, startedAt: 0, warm: 0 };
const R = { state: 'idle', trigger: null, pre: [], preLen: 0, chunks: [], len: 0, aboveLen: 0, belowLen: 0 };
const history = [];
const recSpans = [];
const WARM_CHUNKS = 10;   // 0,5 s para que se asienten los filtros
const HYST_DB = 1;        // histéresis para terminar la grabación
const GAP_MS = 2500;      // más de esto sin audio = hueco de escucha
const MANUAL_MAX = 300;   // 5 min
let lastChunkAt = 0;
let saveChain = Promise.resolve();
let learnJob = null;
let calJob = null;
let newRecs = 0;
let currentTab = 'meter';
let wakeLock = null;

/* ================= Audio ================= */
function codeErr(code) { const e = new Error(code); e.code = code; return e; }

async function startListening() {
  if (A.running || A.starting) return;
  A.starting = true;
  updateListenBtn();
  try {
    if (!window.isSecureContext) throw codeErr('insecure');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw codeErr('nosupport');
    let ctx = new Ctx();
    A.ctx = ctx;
    if (!ctx.audioWorklet) throw codeErr('noworklet');
    ctx.resume().catch(() => {});

    let source;
    if (DEMO) {
      await ctx.audioWorklet.addModule('js/worklet.js');
      source = createDemoSource(ctx);
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw codeErr('nosupport');
      A.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      try {
        source = ctx.createMediaStreamSource(A.stream);
      } catch (e) {
        // Firefox: el contexto debe tener la misma frecuencia que el micrófono
        const rate = A.stream.getAudioTracks()[0]?.getSettings?.().sampleRate;
        if (!rate) throw e;
        try { await ctx.close(); } catch { /* nada */ }
        ctx = new Ctx({ sampleRate: rate });
        A.ctx = ctx;
        source = ctx.createMediaStreamSource(A.stream);
      }
      await ctx.audioWorklet.addModule('js/worklet.js');
      const track = A.stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          if (A.running) { toast('El micrófono se ha desconectado'); stopListening(); }
        });
      }
    }

    A.worklet = new AudioWorkletNode(ctx, 'meter-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    A.worklet.port.onmessage = (e) => onChunk(e.data);
    A.worklet.port.postMessage({ tau: tauSec() });
    A.analyser = ctx.createAnalyser();
    A.analyser.fftSize = 4096;
    A.analyser.smoothingTimeConstant = 0.55;
    A.analyser.minDecibels = -130;
    A.analyser.maxDecibels = 0;
    A.sink = ctx.createGain();
    A.sink.gain.value = 0;
    A.worklet.connect(A.sink);
    A.analyser.connect(A.sink);
    A.sink.connect(ctx.destination);
    A.source = source;
    A.fs = ctx.sampleRate;
    buildChain();
    try { await ctx.resume(); } catch { /* se reintenta al tocar */ }

    resetStats();
    history.length = 0;
    recSpans.length = 0;
    resetRecState();
    R.pre = []; R.preLen = 0;
    lastChunkAt = 0;
    dispLvl = null;
    A.running = true;
    A.stalled = false;
    requestWakeLock();
    clearBanner('error');
  } catch (err) {
    console.error(err);
    await teardown();
    showStartError(err);
  } finally {
    A.starting = false;
    updateAll();
  }
}

function showStartError(err) {
  const name = err && (err.code || err.name);
  const msgs = {
    insecure: 'La app necesita una conexión segura (https) para usar el micrófono.',
    nosupport: 'Este navegador no permite usar el micrófono. Prueba con Chrome o Safari actualizados.',
    noworklet: 'Este navegador es demasiado antiguo (le falta AudioWorklet). Actualiza Chrome o Safari.',
    NotAllowedError: 'Permiso de micrófono denegado. Actívalo en los ajustes del navegador (mira «Ayuda → Permiso del micrófono») y vuelve a pulsar Escuchar.',
    SecurityError: 'El navegador ha bloqueado el micrófono. Revisa los permisos del sitio.',
    NotFoundError: 'No se ha encontrado ningún micrófono.',
    NotReadableError: 'El micrófono está siendo usado por otra app (una llamada, una grabadora…). Ciérrala y vuelve a intentarlo.',
    OverconstrainedError: 'El micrófono no admite la configuración pedida.',
  };
  showBanner('error', msgs[name] || `No se pudo iniciar el micrófono (${(err && err.message) || 'error desconocido'}).`, 'error');
}

async function teardown() {
  try { if (A.worklet) A.worklet.port.onmessage = null; } catch { /* nada */ }
  if (A.stream) A.stream.getTracks().forEach((t) => t.stop());
  A.demoNodes.forEach((n) => { try { n.stop(); } catch { /* nada */ } });
  if (A.ctx) { try { await A.ctx.close(); } catch { /* nada */ } }
  Object.assign(A, { ctx: null, stream: null, source: null, worklet: null, analyser: null, sink: null, filters: [], demoNodes: [], running: false, stalled: false });
}

async function stopListening() {
  if (!A.running) return;
  if (R.state === 'rec') finishRec();
  if (learnJob) { learnJob.reject(new Error('stopped')); learnJob = null; }
  if (calJob) { calJob.reject(new Error('stopped')); calJob = null; }
  await teardown();
  R.pre = []; R.preLen = 0;
  releaseWakeLock();
  dispLvl = null;
  updateAll();
  drawHistory(true);
  drawSpectrum(0, true);
}

function buildChain() {
  if (!A.ctx || !A.source || !A.worklet) return;
  try { A.source.disconnect(); } catch { /* nada */ }
  for (const n of A.filters) { try { n.disconnect(); } catch { /* nada */ } }
  A.filters = [];
  const ctx = A.ctx, nyq = ctx.sampleRate / 2;
  const biquad = (type, f, q) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    A.filters.push(b);
  };
  // Butterworth de 4º orden = dos secciones con Q 0,541 y 1,307
  if (settings.highpass > 0) { biquad('highpass', settings.highpass, 0.5412); biquad('highpass', settings.highpass, 1.3066); }
  if (settings.hum > 0) {
    for (let k = 1; k <= settings.humHarm; k++) {
      const f = settings.hum * k;
      if (f >= nyq * 0.95) break;
      biquad('notch', f, 30);
    }
  }
  if (settings.lowpass > 0 && settings.lowpass < nyq * 0.95) { biquad('lowpass', settings.lowpass, 0.5412); biquad('lowpass', settings.lowpass, 1.3066); }
  let last = A.source;
  for (const n of A.filters) { last.connect(n); last = n; }
  last.connect(A.worklet);
  last.connect(A.analyser);
}

// Fuente simulada (?demo): ruido de fondo, zumbido de 50 Hz y golpes de sonido periódicos
function createDemoSource(ctx) {
  const out = ctx.createGain();
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = (Math.random() * 2 - 1) * 0.002 + b * 0.02; }
  const noise = ctx.createBufferSource();
  noise.buffer = buf; noise.loop = true; noise.connect(out); noise.start();
  const hum = ctx.createOscillator();
  hum.type = 'sawtooth'; hum.frequency.value = 50;
  const hg = ctx.createGain(); hg.gain.value = 0.006;
  hum.connect(hg).connect(out); hum.start();
  const tone = ctx.createOscillator();
  tone.type = 'triangle'; tone.frequency.value = 660;
  const tg = ctx.createGain(); tg.gain.value = 0;
  tone.connect(tg).connect(out); tone.start();
  const t0 = ctx.currentTime + 4;
  for (let i = 0; i < 400; i++) {
    const t = t0 + i * 9, dur = 0.6 + (i % 3) * 0.5, lvl = 0.05 + (i % 4) * 0.04;
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(lvl, t + 0.03);
    tg.gain.setValueAtTime(lvl, t + dur);
    tg.gain.linearRampToValueAtTime(0, t + dur + 0.25);
  }
  A.demoNodes = [noise, hum, tone];
  return out;
}

/* ================= Bloques de audio ================= */
function onChunk(d) {
  const now = Date.now();
  const len = d.samples.length;
  if (lastChunkAt && now - lastChunkAt > GAP_MS) handleGap(lastChunkAt, now);
  lastChunkAt = now;
  if (A.stalled) { A.stalled = false; updateStatus(); }

  const useA = settings.weighting === 'A';
  const raw = pow2db(useA ? d.msA : d.msZ);
  const leqMs = useA ? d.leqA : d.leqZ;
  const peakRaw = amp2db(d.peak);
  S.latest = { raw, peakRaw };
  if (S.warm < WARM_CHUNKS) {
    S.warm++;
  } else {
    if (raw < S.minRaw) S.minRaw = raw;
    if (raw > S.maxRaw) S.maxRaw = raw;
    if (peakRaw > S.peakRaw) S.peakRaw = peakRaw;
    S.energy += leqMs * len;
    S.samples += len;
  }
  history.push({ t: now, raw });
  if (history.length > 7000) history.splice(0, history.length - 6400);

  const chunk = { samples: d.samples, t: now, raw, leqMs, peak: d.peak };
  if (learnJob) feedLearn(chunk);
  if (calJob) feedCal(chunk);
  handleRecorder(chunk);
}

function handleGap(from, to) {
  if (R.state === 'rec') finishRec();
  R.pre = []; R.preLen = 0;
  const secs = Math.round((to - from) / 1000);
  showBanner('gap', `No se escuchó entre las ${fmtTime(new Date(from))} y las ${fmtTime(new Date(to))} (${fmtClock(secs)}). Suele pasar si la pantalla se apaga o la app pasa a segundo plano.`, 'warn');
}

/* ================= Grabación ================= */
function resetRecState() {
  R.state = 'idle'; R.trigger = null; R.chunks = []; R.len = 0; R.aboveLen = 0; R.belowLen = 0;
}

function trimPre() {
  if (!R.pre.length) return;
  const maxLen = settings.pre * A.fs + R.pre[R.pre.length - 1].samples.length;
  while (R.pre.length > 1 && R.preLen > maxLen) R.preLen -= R.pre.shift().samples.length;
}

function handleRecorder(chunk) {
  const len = chunk.samples.length;
  const lvl = chunk.raw + settings.offset;
  if (R.state === 'idle') {
    R.pre.push(chunk);
    R.preLen += len;
    trimPre();
    if (settings.autoRec && S.warm >= WARM_CHUNKS && lvl >= settings.threshold) startRec('auto');
    return;
  }
  R.chunks.push(chunk);
  R.len += len;
  const above = lvl >= settings.threshold - HYST_DB;
  if (lvl >= settings.threshold) R.aboveLen += len;
  R.belowLen = above ? 0 : R.belowLen + len;
  if (R.trigger === 'auto' && !above && R.belowLen >= settings.post * A.fs) { finishRec(); return; }
  const limit = R.trigger === 'manual' ? MANUAL_MAX : settings.maxDur;
  if (R.len >= limit * A.fs) finishRec();
}

function startRec(trigger) {
  R.state = 'rec';
  R.trigger = trigger;
  R.chunks = R.pre;
  R.len = R.preLen;
  R.pre = []; R.preLen = 0;
  R.belowLen = 0;
  const last = R.chunks[R.chunks.length - 1];
  R.aboveLen = trigger === 'auto' && last ? last.samples.length : 0;
  const first = R.chunks[0];
  recSpans.push({ start: first ? first.t - (first.samples.length / A.fs) * 1000 : Date.now(), end: 0 });
  if (recSpans.length > 400) recSpans.shift();
  updateRecUi();
}

function finishRec() {
  if (R.state !== 'rec') return;
  const job = {
    chunks: R.chunks, trigger: R.trigger, aboveSec: R.aboveLen / A.fs, fs: A.fs,
    offset: settings.offset, weighting: settings.weighting,
  };
  resetRecState();
  const span = recSpans[recSpans.length - 1];
  if (span && !span.end) span.end = Date.now();
  updateRecUi();
  if (!job.chunks.length) return;
  if (job.trigger === 'auto' && settings.minEvent > 0 && job.aboveSec < settings.minEvent) {
    if (span) recSpans.pop();
    return;
  }
  saveChain = saveChain
    .then(() => saveRecording(job))
    .catch((e) => { console.error(e); toast('No se pudo guardar la grabación'); });
}

async function saveRecording(job) {
  const { chunks, fs } = job;
  let n = 0;
  for (const c of chunks) n += c.samples.length;
  const data = new Float32Array(n);
  let o = 0, maxRaw = -Infinity, energy = 0, peak = 0;
  for (const c of chunks) {
    data.set(c.samples, o);
    o += c.samples.length;
    if (c.raw > maxRaw) maxRaw = c.raw;
    energy += c.leqMs * c.samples.length;
    if (c.peak > peak) peak = c.peak;
  }
  await nextFrame();
  let out = data, cleaned = false;
  if (settings.nrMode !== 'off') {
    const noise = settings.nrMode === 'profile' ? getNoiseProfile(fs) : null;
    out = await denoiseAsync(out, fs, noise, nrParams());
    cleaned = true;
  }
  if (settings.normalize) out = normalizePeak(out);
  const wav = encodeWav(out, fs);
  const first = chunks[0];
  const meta = {
    date: Math.round(first.t - (first.samples.length / fs) * 1000),
    duration: n / fs,
    sampleRate: fs,
    maxDb: maxRaw + job.offset,
    leqDb: pow2db(energy / n) + job.offset,
    peakDb: amp2db(peak) + job.offset,
    weighting: job.weighting,
    trigger: job.trigger,
    cleaned,
    normalized: settings.normalize,
    wave: waveformPeaks(out, 160),
    size: wav.byteLength,
  };
  await store.addRecording(meta, wav);
  toast(`Grabación guardada · ${fmtDur(meta.duration)} · máx ${fmt1(meta.maxDb)} ${meta.weighting === 'Z' ? 'dB(Z)' : 'dB(A)'}`);
  // En la lista no se redibuja sola: movería las tarjetas bajo el dedo y cortaría el audio que suena
  if (currentTab === 'recs') { pendingNew++; updateNewBar(); }
  else { newRecs++; updateBadge(); }
  requestPersist();
}

let pendingNew = 0;
function updateNewBar() {
  const b = $('#recNewBar');
  b.hidden = pendingNew === 0;
  b.textContent = pendingNew === 1 ? '1 grabación nueva · Mostrar' : `${pendingNew} grabaciones nuevas · Mostrar`;
}

let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage?.persist?.(); } catch { /* nada */ }
}

/* ================= Aprender ruido y calibrar ================= */
function feedLearn(chunk) {
  learnJob.parts.push(chunk.samples);
  learnJob.got += chunk.samples.length;
  const left = Math.ceil((learnJob.need - learnJob.got) / A.fs);
  $('#btnLearn').textContent = `Escuchando ruido… ${Math.max(0, left)}`;
  if (learnJob.got >= learnJob.need) { const j = learnJob; learnJob = null; j.resolve(j.parts); }
}

async function learnNoise() {
  if (!A.running) { toast('Primero pulsa «Escuchar» en el Medidor'); return; }
  if (learnJob) return;
  const btn = $('#btnLearn');
  btn.disabled = true;
  try {
    const parts = await new Promise((resolve, reject) => {
      learnJob = { parts: [], got: 0, need: 3 * A.fs, resolve, reject };
    });
    let n = 0;
    for (const p of parts) n += p.length;
    const x = new Float32Array(n);
    let o = 0;
    for (const p of parts) { x.set(p, o); o += p.length; }
    const fs = A.fs;
    const spec = noiseSpectrum(x, fs, 0.6, frameSizeFor(fs));
    lsSet(NOISE_KEY, JSON.stringify({ fs, n: frameSizeFor(fs), date: Date.now(), spec: Array.from(spec, (v) => +v.toPrecision(5)) }));
    if (settings.nrMode === 'off' || settings.nrMode === 'auto') setSetting('nrMode', 'profile');
    toast('Perfil de ruido guardado');
  } catch (e) {
    if (e.message !== 'stopped') toast('No se pudo aprender el ruido');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aprender ruido de fondo (3 s)';
    updateNoiseStatus();
  }
}

function feedCal(chunk) {
  calJob.sum += chunk.leqMs * chunk.samples.length;
  calJob.n += chunk.samples.length;
  const left = Math.ceil((calJob.need - calJob.n) / A.fs);
  $('#btnCalibrate').textContent = `Midiendo… ${Math.max(0, left)}`;
  if (calJob.n >= calJob.need) { const j = calJob; calJob = null; j.resolve(j.sum / j.n); }
}

async function calibrate() {
  const ref = parseFloat(String($('#calRef').value).replace(',', '.'));
  if (!Number.isFinite(ref) || ref < 10 || ref > 140) { toast('Escribe el valor que marca el sonómetro de referencia'); return; }
  if (!A.running) { toast('Primero pulsa «Escuchar» en el Medidor'); return; }
  if (calJob) return;
  const btn = $('#btnCalibrate');
  btn.disabled = true;
  try {
    const ms = await new Promise((resolve, reject) => { calJob = { sum: 0, n: 0, need: 3 * A.fs, resolve, reject }; });
    const offset = Math.round((ref - pow2db(ms)) * 10) / 10;
    setSetting('offset', clamp(offset, 40, 160));
    toast(`Calibrado: ${fmt1(settings.offset)} dB`);
  } catch (e) {
    if (e.message !== 'stopped') toast('No se pudo calibrar');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Calibrar (3 s)';
  }
}

function updateNoiseStatus() {
  const p = getNoiseMeta();
  const el = $('#noiseStatus');
  if (p && p.date) {
    el.textContent = `Perfil guardado el ${fmtDate(new Date(p.date))} a las ${fmtTime(new Date(p.date))}.`;
    $('#btnForget').hidden = false;
  } else {
    el.textContent = 'No hay perfil guardado. La reducción automática estima el ruido de cada grabación a partir de sus partes más silenciosas.';
    $('#btnForget').hidden = true;
  }
}

/* ================= Pantalla encendida ================= */
async function requestWakeLock() {
  if (!settings.wakeLock || !A.running || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* no permitido */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ================= Medidor (UI) ================= */
const G_MIN = 20, G_MAX = 120;
const dbToAngle = (v) => 150 + 240 * clamp((v - G_MIN) / (G_MAX - G_MIN), 0, 1);
function polar(deg, r) {
  const t = (deg * Math.PI) / 180;
  return [150 + r * Math.cos(t), 150 + r * Math.sin(t)];
}

function buildGauge() {
  let html = '';
  for (let v = G_MIN; v <= G_MAX; v += 10) {
    const a = dbToAngle(v);
    const [x1, y1] = polar(a, 101), [x2, y2] = polar(a, v % 20 === 0 ? 94 : 97);
    html += `<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    if (v % 20 === 0) {
      const [x, y] = polar(a, 83);
      html += `<text class="tick-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${v}</text>`;
    }
  }
  $('#ticks').innerHTML = html;
}

const LEVELS = [
  [25, 'Silencio casi total'],
  [35, 'Muy silencioso, como un susurro'],
  [45, 'Silencioso, como una biblioteca'],
  [55, 'Tranquilo, como una oficina'],
  [65, 'Conversación normal'],
  [75, 'Ruidoso, como una aspiradora'],
  [85, 'Muy ruidoso, como tráfico intenso'],
  [95, 'Dañino si se prolonga'],
  [105, 'Muy alto: protege tus oídos'],
  [Infinity, 'Extremo: riesgo de daño auditivo'],
];
const levelLabel = (v) => LEVELS.find(([lim]) => v < lim)[1];
const zoneVar = (v) => (v < 55 ? 'var(--ok)' : v < 70 ? 'var(--warn)' : v < 85 ? 'var(--hot)' : 'var(--danger)');

let dispLvl = null, lastText = 0;
function renderGauge(ts) {
  const arc = $('#arcVal');
  if (!A.running || !S.latest) {
    arc.setAttribute('stroke-dasharray', '0 100');
    arc.style.opacity = '0';
    $('#dbValue').textContent = '--';
    $('#dbLabel').textContent = A.starting ? 'Iniciando micrófono…' : 'Pulsa «Escuchar» para empezar';
    $('#maxMark').setAttribute('visibility', 'hidden');
    return;
  }
  const target = S.latest.raw + settings.offset;
  dispLvl = dispLvl == null ? target : dispLvl + (target - dispLvl) * 0.35;
  const pct = clamp((dispLvl - G_MIN) / (G_MAX - G_MIN), 0, 1) * 100;
  arc.setAttribute('stroke-dasharray', `${pct.toFixed(2)} 100`);
  arc.style.opacity = pct > 0.3 ? '1' : '0';
  arc.style.setProperty('--zone', zoneVar(target));
  if (ts - lastText > 200) {
    lastText = ts;
    $('#dbValue').textContent = fmt1(target);
    $('#dbLabel').textContent = levelLabel(target);
    renderStats();
  }
}

function renderStats() {
  const off = settings.offset;
  const has = S.samples > 0;
  $('#stMin').textContent = has ? fmt1(S.minRaw + off) : '--';
  $('#stMax').textContent = has ? fmt1(S.maxRaw + off) : '--';
  $('#stLeq').textContent = has ? fmt1(pow2db(S.energy / S.samples) + off) : '--';
  $('#stPeak').textContent = has ? fmt1(S.peakRaw + off) : '--';
  $('#stTime').textContent = A.running && S.startedAt ? fmtClock((Date.now() - S.startedAt) / 1000, true) : '0:00:00';
  const mm = $('#maxMark');
  if (has && A.running) {
    const [x, y] = polar(dbToAngle(S.maxRaw + off), 120);
    mm.setAttribute('cx', x.toFixed(1));
    mm.setAttribute('cy', y.toFixed(1));
    mm.setAttribute('visibility', 'visible');
  } else {
    mm.setAttribute('visibility', 'hidden');
  }
}

function resetStats() {
  Object.assign(S, { minRaw: Infinity, maxRaw: -Infinity, peakRaw: -Infinity, energy: 0, samples: 0, startedAt: Date.now(), warm: Math.min(S.warm, WARM_CHUNKS) });
  if (!A.running) S.warm = 0;
  renderStats();
}

function updateThresholdMark() {
  const m = $('#thrMark');
  if (!settings.autoRec) { m.setAttribute('visibility', 'hidden'); return; }
  const a = dbToAngle(settings.threshold);
  const [x1, y1] = polar(a, 106), [x2, y2] = polar(a, 134);
  m.setAttribute('x1', x1.toFixed(1)); m.setAttribute('y1', y1.toFixed(1));
  m.setAttribute('x2', x2.toFixed(1)); m.setAttribute('y2', y2.toFixed(1));
  m.setAttribute('visibility', 'visible');
}

function updateUnits() {
  $$('.unit-w').forEach((e) => { e.textContent = unitLabel(); });
}

function updateFilterChips() {
  const chips = [];
  if (settings.hum > 0) chips.push(`Sin zumbido ${settings.hum} Hz`);
  if (settings.highpass > 0) chips.push(`Graves < ${settings.highpass} Hz fuera`);
  if (settings.lowpass > 0) chips.push(`Agudos > ${settings.lowpass / 1000} kHz fuera`);
  if (settings.nrMode !== 'off') chips.push('Reducción de ruido al guardar');
  $('#filterChips').innerHTML = chips.map((c) => `<span class="chip-static">${c}</span>`).join('');
}

function updateAutoHint() {
  const pre = nfMax1.format(settings.pre), post = nfMax1.format(settings.post);
  $('#autoHint').textContent = `Graba ${pre} s antes y ${post} s después de cada sonido que supere el umbral.`;
}

function updateListenBtn() {
  const b = $('#btnListen');
  b.classList.toggle('is-on', A.running);
  b.disabled = A.starting;
  $('#btnListenLabel').textContent = A.starting ? 'Iniciando…' : A.running ? 'Detener' : 'Escuchar';
}

function updateRecUi() {
  const b = $('#btnRec');
  b.disabled = !A.running;
  const on = R.state === 'rec';
  b.classList.toggle('is-on', on);
  $('#btnRecLabel').textContent = on ? `Parar ${fmtClock(R.len / A.fs)}` : 'Grabar';
  updateStatus();
}

function updateStatus() {
  const el = $('#status');
  let state = 'off', text = 'Detenido';
  if (A.starting) { state = 'off'; text = 'Iniciando…'; }
  else if (A.running) {
    if (A.stalled) { state = 'warn'; text = 'En pausa'; }
    else if (R.state === 'rec') { state = 'rec'; text = `Grabando ${fmtClock(R.len / A.fs)}`; }
    else { state = 'on'; text = settings.autoRec ? 'Esperando sonido' : 'Escuchando'; }
  }
  el.dataset.state = state;
  $('#statusText').textContent = text;
}

function updateBadge() {
  const b = $('#recBadge');
  b.hidden = newRecs === 0;
  b.textContent = newRecs > 99 ? '99+' : String(newRecs);
}

function updateAll() {
  updateListenBtn();
  updateRecUi();
  updateStatus();
  updateUnits();
  updateThresholdMark();
  updateFilterChips();
  updateAutoHint();
  renderGauge(performance.now());
  renderStats();
}

/* ================= Banners ================= */
function showBanner(id, text, kind = 'warn') {
  let el = document.getElementById(`banner-${id}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `banner-${id}`;
    el.innerHTML = '<p></p><button class="x" type="button" aria-label="Cerrar">×</button>';
    el.querySelector('.x').addEventListener('click', () => el.remove());
    $('#banners').prepend(el);
  }
  el.className = `banner ${kind}`;
  el.querySelector('p').textContent = text;
}
function clearBanner(id) {
  const el = document.getElementById(`banner-${id}`);
  if (el) el.remove();
}

/* ================= Gráficas ================= */
let col = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  col = {
    muted: v('--muted'), grid: v('--border'), accent: v('--accent'), danger: v('--danger'), text: v('--text'),
    recFill: hexA(v('--danger'), 0.16), accentFill: hexA(v('--accent'), 0.16), accentFill0: hexA(v('--accent'), 0),
  };
}

function prepCanvas(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = c.clientWidth, h = c.clientHeight;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

let lastHist = 0;
function drawHistory(force = false, ts = performance.now()) {
  if (!force && ts - lastHist < 33) return;
  lastHist = ts;
  const c = $('#histCanvas');
  if (!c.clientWidth) return;
  const { g, w, h } = prepCanvas(c);
  g.clearRect(0, 0, w, h);
  const padL = 26, padB = 16, padT = 4;
  const pw = w - padL, ph = h - padB - padT;
  const yMin = 20, yMax = 120;
  const Y = (v) => padT + ph - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * ph;
  const now = Date.now(), span = settings.historyWin * 1000, t0 = now - span;
  const X = (t) => padL + ((t - t0) / span) * pw;

  g.font = '10px system-ui, sans-serif';
  g.lineWidth = 1;
  g.strokeStyle = col.grid;
  g.fillStyle = col.muted;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let v = 40; v <= 120; v += 20) {
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(w, y); g.stroke();
    g.fillText(String(v), padL - 5, y);
  }
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText(settings.historyWin >= 60 ? `−${settings.historyWin / 60} min` : `−${settings.historyWin} s`, padL, h - 3);
  g.textAlign = 'right';
  g.fillText('ahora', w, h - 3);

  g.fillStyle = col.recFill;
  for (const s of recSpans) {
    const e = s.end || now;
    if (e < t0) continue;
    const x1 = Math.max(padL, X(s.start)), x2 = X(e);
    g.fillRect(x1, padT, Math.max(2, x2 - x1), ph);
  }

  if (settings.autoRec) {
    const y = Math.round(Y(settings.threshold)) + 0.5;
    g.save();
    g.setLineDash([5, 4]);
    g.strokeStyle = col.accent;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(w, y); g.stroke();
    g.restore();
  }

  // Línea: máximo por columna de píxel, cortando en los huecos
  const off = settings.offset;
  const segs = [];
  let seg = [], px = -1, m = -Infinity, prevT = 0;
  for (let i = Math.max(0, lowerBound(history, t0) - 1); i < history.length; i++) {
    const p = history[i];
    if (prevT && p.t - prevT > 1500) {
      if (px >= 0) seg.push([px, m]);
      if (seg.length) segs.push(seg);
      seg = []; px = -1; m = -Infinity;
    }
    prevT = p.t;
    const x = Math.max(padL, Math.round(X(p.t)));
    const v = p.raw + off;
    if (x !== px) { if (px >= 0) seg.push([px, m]); px = x; m = v; } else if (v > m) m = v;
  }
  if (px >= 0) seg.push([px, m]);
  if (seg.length) segs.push(seg);

  const grad = g.createLinearGradient(0, padT, 0, padT + ph);
  grad.addColorStop(0, col.accentFill);
  grad.addColorStop(1, col.accentFill0);
  for (const s of segs) {
    if (s.length < 2) continue;
    g.beginPath();
    g.moveTo(s[0][0], Y(s[0][1]));
    for (let i = 1; i < s.length; i++) g.lineTo(s[i][0], Y(s[i][1]));
    g.strokeStyle = col.accent;
    g.lineWidth = 1.8;
    g.lineJoin = 'round';
    g.stroke();
    g.lineTo(s[s.length - 1][0], padT + ph);
    g.lineTo(s[0][0], padT + ph);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
  }

  if (!A.running && !history.length) {
    g.fillStyle = col.muted;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '12px system-ui, sans-serif';
    g.fillText('Sin datos todavía', padL + pw / 2, padT + ph / 2);
  }
}

let specBuf = null, lastSpec = 0, lastPeakTxt = 0;
function fmtHz(f) {
  return f >= 1000 ? `${nfMax1.format(f / 1000)} kHz` : `${nf0.format(f)} Hz`;
}
function drawSpectrum(ts, force = false) {
  if (!force && ts - lastSpec < 40) return;
  lastSpec = ts;
  const c = $('#specCanvas');
  if (!c.clientWidth) return;
  const { g, w, h } = prepCanvas(c);
  g.clearRect(0, 0, w, h);
  const padB = 16, ph = h - padB;
  const fs = A.fs || 48000;
  const fMin = 20, fMax = Math.min(20000, fs / 2);
  const lMin = Math.log10(fMin), lR = Math.log10(fMax) - lMin;
  const X = (f) => ((Math.log10(f) - lMin) / lR) * w;
  const dbMin = -125, dbMax = -25;
  const Y = (d) => ph - ((clamp(d, dbMin, dbMax) - dbMin) / (dbMax - dbMin)) * ph;

  g.font = '10px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineWidth = 1;
  for (const [f, label] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
    if (f > fMax) continue;
    const x = Math.round(X(f)) + 0.5;
    g.strokeStyle = col.grid;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ph); g.stroke();
    g.fillStyle = col.muted;
    g.fillText(label, clamp(x, 10, w - 12), h - 3);
  }
  if (!A.running || !A.analyser) {
    $('#specPeak').textContent = '';
    return;
  }
  const n = A.analyser.frequencyBinCount;
  if (!specBuf || specBuf.length !== n) specBuf = new Float32Array(n);
  A.analyser.getFloatFrequencyData(specBuf);
  const binHz = fs / A.analyser.fftSize;
  const pts = [];
  let px = -1, m = -Infinity, pk = -1, pv = -Infinity;
  for (let k = Math.max(1, Math.ceil(fMin / binHz)); k < n; k++) {
    const f = k * binHz;
    if (f > fMax) break;
    const v = specBuf[k];
    if (v > pv) { pv = v; pk = k; }
    const x = Math.round(X(f));
    if (x !== px) { if (px >= 0) pts.push([px, m]); px = x; m = v; } else if (v > m) m = v;
  }
  if (px >= 0) pts.push([px, m]);
  if (pts.length > 1) {
    g.beginPath();
    g.moveTo(pts[0][0], ph);
    for (const [x, v] of pts) g.lineTo(x, Y(v));
    g.lineTo(pts[pts.length - 1][0], ph);
    g.closePath();
    g.fillStyle = col.accentFill;
    g.fill();
    g.beginPath();
    pts.forEach(([x, v], i) => (i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v))));
    g.strokeStyle = col.accent;
    g.lineWidth = 1.5;
    g.stroke();
  }
  if (ts - lastPeakTxt > 500) {
    lastPeakTxt = ts;
    let txt = '';
    // Solo se muestra si es un pico real: no en el borde y al menos 10 dB sobre su entorno
    const kStart = Math.max(1, Math.ceil(fMin / binHz));
    let around = 0, cnt = 0;
    for (let k = pk - 14; k <= pk + 14; k++) {
      if (k < kStart || k >= n || Math.abs(k - pk) < 5) continue;
      around += specBuf[k]; cnt++;
    }
    const prominent = cnt > 0 && pv - around / cnt > 10;
    if (pk > kStart && pk < n - 1 && pv > -105 && prominent) {
      const a = specBuf[pk - 1], b = specBuf[pk], cc = specBuf[pk + 1];
      const den = a - 2 * b + cc;
      const delta = den !== 0 ? clamp((0.5 * (a - cc)) / den, -0.5, 0.5) : 0;
      txt = `Frecuencia dominante: ${fmtHz((pk + delta) * binHz)}`;
    }
    $('#specPeak').textContent = txt;
  }
}

/* ================= Bucle de dibujo ================= */
let lastStatus = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (currentTab === 'meter') {
    if (A.running) {
      renderGauge(ts);
      drawHistory(false, ts);
      drawSpectrum(ts);
    }
  } else if (currentTab === 'settings' && ts - lastText > 250) {
    lastText = ts;
    $('#rawDbfs').textContent = A.running && S.latest ? fmt1(S.latest.raw) : '--';
  }
  if (ts - lastStatus > 250) {
    lastStatus = ts;
    if (A.running) { updateStatus(); if (R.state === 'rec') updateRecUi(); }
  }
}

setInterval(() => {
  if (!A.running) return;
  const stalled = !!lastChunkAt && Date.now() - lastChunkAt > GAP_MS;
  if (stalled !== A.stalled) { A.stalled = stalled; updateStatus(); }
  if (A.ctx && A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
}, 1000);

/* ================= Grabaciones (UI) ================= */
let recCache = new Map();
let objectUrls = [];
const canShareFiles = (() => {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(4)], 't.wav', { type: 'audio/wav' })] }));
  } catch { return false; }
})();

function recCardHtml(r) {
  const d = new Date(r.date);
  const unit = r.weighting === 'Z' ? 'dB(Z)' : 'dB(A)';
  return `<article class="rec card" data-id="${r.id}">
    <div class="rec-head">
      <div>
        <div class="rec-date">${fmtDate(d)}</div>
        <div class="rec-time">${fmtTime(d)} · ${unit}</div>
      </div>
      <div class="badges">
        <span class="badge">${r.trigger === 'auto' ? 'Automática' : 'Manual'}</span>
        ${r.cleaned ? '<span class="badge badge-ok">Sin ruido</span>' : ''}
        ${r.maxDb >= 85 ? '<span class="badge badge-hot">Muy alto</span>' : ''}
      </div>
    </div>
    <canvas class="wave" aria-hidden="true"></canvas>
    <dl class="rec-stats">
      <div><dt>Duración</dt><dd>${fmtDur(r.duration)}</dd></div>
      <div><dt>Máx</dt><dd>${fmt1(r.maxDb)}</dd></div>
      <div><dt>Media</dt><dd>${fmt1(r.leqDb)}</dd></div>
      <div><dt>Pico</dt><dd>${fmt1(r.peakDb)}</dd></div>
    </dl>
    <div data-player></div>
    <div class="rec-actions">
      <button class="btn btn-sm" type="button" data-act="play"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>Escuchar</button>
      <button class="btn btn-sm" type="button" data-act="download">Descargar</button>
      ${canShareFiles ? '<button class="btn btn-sm" type="button" data-act="share">Compartir</button>' : ''}
      <button class="btn btn-sm" type="button" data-act="clean">Quitar ruido</button>
      <button class="btn btn-sm btn-danger-ghost" type="button" data-act="delete">Borrar</button>
    </div>
  </article>`;
}

function drawWave(canvas, peaks) {
  if (!canvas.clientWidth || !peaks || !peaks.length) return;
  const { g, w, h } = prepCanvas(canvas);
  g.clearRect(0, 0, w, h);
  const max = Math.max(...peaks, 1e-6);
  const bw = w / peaks.length;
  g.fillStyle = col.accent;
  for (let i = 0; i < peaks.length; i++) {
    const rel = peaks[i] / max;
    const v = rel > 0 ? clamp(1 + (20 * Math.log10(rel)) / 42, 0.04, 1) : 0.04;
    const bh = Math.max(2, v * h);
    g.fillRect(i * bw + bw * 0.15, (h - bh) / 2, Math.max(1, bw * 0.7), bh);
  }
}

async function renderRecs() {
  const list = $('#recList');
  pendingNew = 0;
  updateNewBar();
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  let recs;
  try {
    recs = await store.listMeta();
  } catch (e) {
    console.error(e);
    list.innerHTML = '<div class="card empty">No se pudo abrir el almacenamiento del navegador. Si estás en modo incógnito, las grabaciones no se pueden guardar.</div>';
    return;
  }
  recs.sort((a, b) => b.date - a.date || b.id - a.id);
  recCache = new Map(recs.map((r) => [r.id, r]));
  const total = recs.reduce((s, r) => s + (r.size || 0), 0);
  $('#recSummary').textContent = recs.length
    ? `${recs.length} ${recs.length === 1 ? 'grabación' : 'grabaciones'} · ${fmtBytes(total)}`
    : '';
  $('#btnCsv').disabled = !recs.length;
  $('#btnClearAll').disabled = !recs.length;
  if (!recs.length) {
    list.innerHTML = `<div class="card empty">
      <svg class="empty-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h1.5M7 8.5v7M10.5 5v14M14 9v6M17.5 6.5v11M21 12h-.5"/></svg>
      Aún no hay grabaciones.<br>Activa la <b>grabación automática</b> en el Medidor o pulsa <b>Grabar</b>.
    </div>`;
    return;
  }
  list.innerHTML = recs.map(recCardHtml).join('');
  $$('.rec', list).forEach((el) => drawWave(el.querySelector('.wave'), recCache.get(+el.dataset.id)?.wave));
}

async function getWavBlob(id) {
  const buf = await store.getAudio(id);
  if (!buf) throw new Error('Audio no encontrado');
  return new Blob([buf], { type: 'audio/wav' });
}
function recFileName(r) {
  return `sonido_${fileStamp(new Date(r.date))}${r.cleaned ? '_sin-ruido' : ''}.wav`;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
}

async function onRecAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.rec');
  const id = +card.dataset.id;
  const r = recCache.get(id);
  if (!r) return;
  const act = btn.dataset.act;
  try {
    if (act === 'play') {
      const url = URL.createObjectURL(await getWavBlob(id));
      objectUrls.push(url);
      const holder = card.querySelector('[data-player]');
      holder.innerHTML = '';
      const audio = document.createElement('audio');
      audio.controls = true; audio.src = url; audio.preload = 'auto';
      holder.appendChild(audio);
      btn.hidden = true;
      audio.play().catch(() => {});
    } else if (act === 'download') {
      downloadBlob(await getWavBlob(id), recFileName(r));
    } else if (act === 'share') {
      const file = new File([await getWavBlob(id)], recFileName(r), { type: 'audio/wav' });
      try {
        await navigator.share({ files: [file], title: 'Grabación del sonómetro', text: `${fmtDate(new Date(r.date))} ${fmtTime(new Date(r.date))} · máx ${fmt1(r.maxDb)} ${r.weighting === 'Z' ? 'dB(Z)' : 'dB(A)'}` });
      } catch (err) {
        if (err && err.name !== 'AbortError') downloadBlob(file, file.name);
      }
    } else if (act === 'clean') {
      await cleanRecording(id, btn);
    } else if (act === 'delete') {
      if (!confirm('¿Borrar esta grabación? No se puede deshacer.')) return;
      await store.deleteRecording(id);
      toast('Grabación borrada');
      renderRecs();
    }
  } catch (err) {
    console.error(err);
    toast('No se pudo completar la acción');
  }
}

async function cleanRecording(id, btn) {
  const meta = recCache.get(id);
  btn.disabled = true;
  btn.textContent = 'Procesando…';
  try {
    const buf = await store.getAudio(id);
    const { samples, sampleRate } = decodeWav(buf);
    const noise = settings.nrMode === 'auto' ? null : getNoiseProfile(sampleRate);
    let out = await denoiseAsync(samples, sampleRate, noise, nrParams());
    if (meta.normalized) out = normalizePeak(out);
    const wav = encodeWav(out, sampleRate);
    const copy = { ...meta, cleaned: true, wave: waveformPeaks(out, 160), size: wav.byteLength, derivedFrom: id };
    delete copy.id;
    await store.addRecording(copy, wav);
    toast(noise ? 'Copia sin ruido creada (con tu perfil de ruido)' : 'Copia sin ruido creada');
    renderRecs();
  } catch (err) {
    console.error(err);
    toast('No se pudo procesar la grabación');
    btn.disabled = false;
    btn.textContent = 'Quitar ruido';
  }
}

async function exportCsv() {
  const recs = (await store.listMeta()).sort((a, b) => a.date - b.date);
  if (!recs.length) { toast('No hay grabaciones'); return; }
  const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  const rows = [['fecha', 'hora', 'duracion_s', 'max_dB', 'media_dB', 'pico_dB', 'ponderacion', 'tipo', 'sin_ruido', 'archivo'].join(';')];
  for (const r of recs) {
    const d = new Date(r.date);
    rows.push([
      isoDate(d), fmtTime(d), nf.format(r.duration), nf.format(r.maxDb), nf.format(r.leqDb), nf.format(r.peakDb),
      r.weighting === 'Z' ? 'dB(Z)' : 'dB(A)', r.trigger === 'auto' ? 'automática' : 'manual', r.cleaned ? 'sí' : 'no', recFileName(r),
    ].join(';'));
  }
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `sonometro_registro_${isoDate(new Date())}.csv`);
}

/* ================= Ajustes (UI) ================= */
function formatOut(key, v) {
  if (key === 'threshold') return nf0.format(v);
  if (key === 'pre' || key === 'post') return nfMax1.format(v);
  if (key === 'offset') return nf1.format(v);
  return String(v);
}

function syncControls(key) {
  const v = settings[key];
  $$(`[data-setting="${key}"]`).forEach((el) => {
    if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'range' || document.activeElement !== el) el.value = String(v);
  });
  $$(`[data-out="${key}"]`).forEach((o) => { o.textContent = formatOut(key, v); });
}

function setSetting(key, val) {
  if (typeof DEFAULTS[key] === 'number') {
    val = parseFloat(String(val).replace(',', '.'));
    if (!Number.isFinite(val)) { syncControls(key); return; }
  }
  if (key === 'threshold') val = clamp(Math.round(val), 20, 110);
  if (key === 'offset') val = clamp(val, 40, 160);
  settings[key] = val;
  saveSettings();
  syncControls(key);
  applySetting(key);
}

function applySetting(key) {
  switch (key) {
    case 'hum': case 'humHarm': case 'highpass': case 'lowpass':
      if (A.running) buildChain();
      updateFilterChips();
      break;
    case 'nrMode':
      updateFilterChips();
      break;
    case 'tau':
      if (A.worklet) A.worklet.port.postMessage({ tau: tauSec() });
      break;
    case 'weighting':
      updateUnits();
      resetStats();
      break;
    case 'wakeLock':
      if (settings.wakeLock) requestWakeLock(); else releaseWakeLock();
      break;
    case 'pre':
      if (A.running) trimPre();
      updateAutoHint();
      break;
    case 'post':
      updateAutoHint();
      break;
    case 'autoRec':
      updateThresholdMark();
      updateStatus();
      drawHistory(true);
      if (settings.autoRec && !A.running) toast('Pulsa «Escuchar» para empezar a vigilar');
      break;
    case 'threshold':
      updateThresholdMark();
      drawHistory(true);
      break;
    case 'offset':
      renderStats();
      drawHistory(true);
      break;
    case 'historyWin':
      drawHistory(true);
      break;
    default:
  }
}

function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    const ev = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      if (el.type === 'radio' && !el.checked) return;
      setSetting(key, el.type === 'checkbox' ? el.checked : el.value);
    });
  });
  Object.keys(DEFAULTS).forEach(syncControls);
}

/* ================= Pestañas ================= */
function switchTab(tab, scrollTo) {
  currentTab = tab;
  $$('.tab').forEach((s) => s.classList.toggle('is-active', s.dataset.tab === tab));
  $$('.tabbar button').forEach((b) => {
    if (b.dataset.go === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  lsSet(TAB_KEY, tab);
  if (tab === 'recs') { newRecs = 0; updateBadge(); renderRecs(); }
  if (tab === 'meter') { drawHistory(true); drawSpectrum(performance.now(), true); renderGauge(performance.now()); }
  if (tab === 'settings') updateNoiseStatus();
  if (scrollTo) document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo(0, 0);
}

/* ================= Inicio ================= */
let installEvt = null;

function init() {
  readColors();
  buildGauge();
  bindSettings();

  $('#btnListen').addEventListener('click', () => (A.running ? stopListening() : startListening()));
  $('#btnRec').addEventListener('click', () => {
    if (!A.running) return;
    if (R.state === 'rec') finishRec(); else startRec('manual');
  });
  $('#btnReset').addEventListener('click', () => { resetStats(); toast('Estadísticas reiniciadas'); });
  $$('[data-step]').forEach((b) => b.addEventListener('click', () => setSetting('threshold', settings.threshold + +b.dataset.step)));
  $('#lnkAutoSettings').addEventListener('click', () => switchTab('settings', 'grp-auto'));
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.go)));
  $('#recList').addEventListener('click', onRecAction);
  $('#recNewBar').addEventListener('click', () => { renderRecs(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#btnCsv').addEventListener('click', () => exportCsv().catch(() => toast('No se pudo exportar')));
  $('#btnClearAll').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODAS las grabaciones? No se puede deshacer.')) return;
    try { await store.clearAll(); toast('Grabaciones borradas'); } catch { toast('No se pudieron borrar'); }
    renderRecs();
  });
  $('#btnLearn').addEventListener('click', learnNoise);
  $('#btnForget').addEventListener('click', () => {
    lsDel(NOISE_KEY);
    if (settings.nrMode === 'profile') setSetting('nrMode', 'auto');
    updateNoiseStatus();
    toast('Perfil de ruido borrado');
  });
  $('#btnCalibrate').addEventListener('click', calibrate);
  $('#btnResetSettings').addEventListener('click', () => {
    if (!confirm('¿Volver a los ajustes por defecto? Se perderá la calibración.')) return;
    settings = { ...DEFAULTS };
    saveSettings();
    Object.keys(DEFAULTS).forEach((k) => { syncControls(k); applySetting(k); });
    toast('Ajustes restablecidos');
  });

  if (!('wakeLock' in navigator)) {
    $('#wakeHint').textContent = 'Este navegador no permite mantenerla encendida desde la web: sube el tiempo de bloqueo automático en los ajustes del móvil.';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && A.running) {
      requestWakeLock();
      if (A.ctx && A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
    }
  });
  document.addEventListener('pointerdown', () => {
    if (A.running && A.ctx && A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
  });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { readColors(); drawHistory(true); drawSpectrum(performance.now(), true); if (currentTab === 'recs') renderRecs(); };
  if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { drawHistory(true); drawSpectrum(performance.now(), true); }, 150);
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    $('#btnInstall').hidden = false;
  });
  $('#btnInstall').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch { /* nada */ }
    installEvt = null;
    $('#btnInstall').hidden = true;
  });

  window.addEventListener('beforeunload', (e) => {
    if (R.state === 'rec') { e.preventDefault(); e.returnValue = ''; }
  });

  if (DEMO) showBanner('demo', 'Modo demostración: se usa un sonido simulado (ruido de fondo, zumbido de 50 Hz y pitidos cada 9 s) en lugar del micrófono.', 'info');

  const savedTab = lsGet(TAB_KEY);
  switchTab(['meter', 'recs', 'settings', 'help'].includes(savedTab) ? savedTab : 'meter');
  updateAll();
  drawHistory(true);
  drawSpectrum(0, true);
  updateNoiseStatus();
  requestAnimationFrame(loop);

  const host = location.hostname;
  if ('serviceWorker' in navigator && host !== 'localhost' && host !== '127.0.0.1') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

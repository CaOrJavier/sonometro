// Utilidades de procesado: FFT, reducción de ruido espectral, WAV.

export class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
  }

  // Transformada in situ. inverse=true incluye el factor 1/n.
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cs[t], wi = sgn * sn[t];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

const fftCache = new Map();
function getFFT(n) {
  let f = fftCache.get(n);
  if (!f) { f = new FFT(n); fftCache.set(n, f); }
  return f;
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

// ~43 ms: resolución de ~23 Hz, suficiente para separar los armónicos de un zumbido de 50/60 Hz
export function frameSizeFor(fs) {
  return fs > 32000 ? 2048 : 1024;
}

// Espectro de potencia medio del ruido, usando solo la fracción de tramas más silenciosas.
export function noiseSpectrum(x, fs, quietFraction = 0.2, N = frameSizeFor(fs)) {
  const hop = N >> 1, bins = (N >> 1) + 1, win = hann(N), fft = getFFT(N);
  let src = x;
  if (src.length < N) { const p = new Float32Array(N); p.set(src); src = p; }
  const frames = Math.floor((src.length - N) / hop) + 1;
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = src[o + i] * win[i]; e += v * v; }
    energy[f] = e;
  }
  const idx = Array.from({ length: frames }, (_, i) => i).sort((a, b) => energy[a] - energy[b]);
  const count = Math.min(frames, Math.max(4, Math.round(frames * quietFraction)));
  const psd = new Float64Array(bins);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let j = 0; j < count; j++) {
    const o = idx[j] * hop;
    for (let i = 0; i < N; i++) { re[i] = src[o + i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);
    for (let k = 0; k < bins; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k < bins; k++) psd[k] /= count;
  return psd;
}

// Reducción de ruido por sustracción espectral (STFT, Hann, solape 75 %).
// noise: espectro de potencia del ruido (si falta, se estima del propio audio).
export function denoise(x, fs, { noise = null, strength = 2, floor = 0.1, N = frameSizeFor(fs) } = {}) {
  const hop = N >> 2, bins = (N >> 1) + 1;
  if (!noise || noise.length !== bins) noise = noiseSpectrum(x, fs, 0.2, N);
  const win = hann(N), fft = getFFT(N);
  const pad = N;
  const total = Math.ceil((x.length + 2 * pad) / hop) * hop + N;
  const src = new Float32Array(total);
  src.set(x, pad);
  const out = new Float64Array(total);
  const re = new Float64Array(N), im = new Float64Array(N);
  const gPrev = new Float64Array(bins).fill(1);
  const g = new Float64Array(bins), gs = new Float64Array(bins);
  const floor2 = floor * floor;

  for (let o = 0; o + N <= total; o += hop) {
    for (let i = 0; i < N; i++) { re[i] = src[o + i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      let gain = 1 - strength * noise[k] / (p + 1e-30);
      if (gain < floor2) gain = floor2;
      gain = Math.sqrt(gain);
      if (gain < gPrev[k]) gain = 0.6 * gPrev[k] + 0.4 * gain; // caída suave: menos «ruido musical»
      g[k] = gain;
    }
    gPrev.set(g);
    gs[0] = g[0];
    gs[bins - 1] = g[bins - 1];
    for (let k = 1; k < bins - 1; k++) gs[k] = 0.25 * g[k - 1] + 0.5 * g[k] + 0.25 * g[k + 1];
    for (let k = 0; k < bins; k++) {
      re[k] *= gs[k]; im[k] *= gs[k];
      if (k > 0 && k < bins - 1) { re[N - k] *= gs[k]; im[N - k] *= gs[k]; }
    }
    fft.transform(re, im, true);
    for (let i = 0; i < N; i++) out[o + i] += re[i] * win[i];
  }

  const res = new Float32Array(x.length);
  const s = 1 / 1.5; // suma de Hann² con solape del 75 %
  for (let i = 0; i < x.length; i++) res[i] = out[pad + i] * s;
  return res;
}

export function normalizePeak(x, target = 0.89, maxGain = 31.6) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  if (p < 1e-6) return x;
  const g = Math.min(target / p, maxGain);
  if (g <= 1) return x;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

export function waveformPeaks(x, n = 160) {
  const out = new Array(n).fill(0);
  const step = x.length / n;
  for (let b = 0; b < n; b++) {
    const s = Math.floor(b * step), e = Math.min(x.length, Math.floor((b + 1) * step));
    let m = 0;
    for (let i = s; i < e; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
    out[b] = Math.round(m * 1e5) / 1e5;
  }
  return out;
}

// WAV PCM 16 bits mono
export function encodeWav(samples, fs) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    let s = samples[i];
    s = s > 1 ? 1 : s < -1 ? -1 : s;
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export function decodeWav(buf) {
  const v = new DataView(buf);
  const str = (o, l) => String.fromCharCode(...new Uint8Array(buf, o, l));
  if (v.byteLength < 44 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('WAV no válido');
  let p = 12, fs = 48000, ch = 1, bits = 16, data = null;
  while (p + 8 <= v.byteLength) {
    const id = str(p, 4), size = v.getUint32(p + 4, true);
    if (id === 'fmt ') {
      ch = v.getUint16(p + 10, true);
      fs = v.getUint32(p + 12, true);
      bits = v.getUint16(p + 22, true);
    } else if (id === 'data') {
      data = { off: p + 8, size: Math.min(size, v.byteLength - p - 8) };
      break;
    }
    p += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error('Formato WAV no soportado');
  const frames = Math.floor(data.size / (2 * ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += v.getInt16(data.off + (i * ch + c) * 2, true);
    out[i] = s / ch / 32768;
  }
  return { samples: out, sampleRate: fs };
}

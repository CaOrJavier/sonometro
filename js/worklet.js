// AudioWorklet: mide el nivel (ponderación Z y A, con integración rápida o lenta)
// y envía el audio en bloques de 50 ms al hilo principal para el búfer de pre-grabación.

// Transformada bilineal de una sección analógica de 2º orden
// N(s) = n2 s² + n1 s + n0, D(s) = d2 s² + d1 s + d0, con s = c (1 - z⁻¹)/(1 + z⁻¹)
function bilinear(n2, n1, n0, d2, d1, d0, c) {
  const c2 = c * c;
  const b0 = n2 * c2 + n1 * c + n0;
  const b1 = 2 * (n0 - n2 * c2);
  const b2 = n2 * c2 - n1 * c + n0;
  const a0 = d2 * c2 + d1 * c + d0;
  const a1 = 2 * (d0 - d2 * c2);
  const a2 = d2 * c2 - d1 * c + d0;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function sosMagnitude(sos, f, fs) {
  const w = 2 * Math.PI * f / fs;
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  let m = 1;
  for (const s of sos) {
    const nr = s.b0 + s.b1 * c1 + s.b2 * c2, ni = s.b1 * s1 + s.b2 * s2;
    const dr = 1 + s.a1 * c1 + s.a2 * c2, di = s.a1 * s1 + s.a2 * s2;
    m *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return m;
}

// Filtro de ponderación A (IEC 61672) en 3 secciones bicuadráticas
function designAWeighting(fs) {
  const c = 2 * fs;
  const w = (f) => (f < 0.42 * fs ? c * Math.tan(Math.PI * f / fs) : 2 * Math.PI * f); // pre-warping
  const w1 = w(20.598997), w2 = w(107.65265), w3 = w(737.86223), w4 = w(12194.217);
  const sos = [
    bilinear(1, 0, 0, 1, 2 * w1, w1 * w1, c),        // s² / (s + w1)²
    bilinear(1, 0, 0, 1, w2 + w3, w2 * w3, c),       // s² / ((s + w2)(s + w3))
    bilinear(0, 0, 1, 1, 2 * w4, w4 * w4, c),        // 1 / (s + w4)²
  ];
  const g = sosMagnitude(sos, 1000, fs); // 0 dB a 1 kHz
  sos[0].b0 /= g; sos[0].b1 /= g; sos[0].b2 /= g;
  return sos;
}

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sos = designAWeighting(sampleRate);
    this.z = this.sos.map(() => new Float64Array(2));
    this.setTau(0.125);
    this.msZ = 1e-12;
    this.msA = 1e-12;
    this.sumZ = 0;
    this.sumA = 0;
    this.peak = 0;
    this.size = Math.max(128, Math.round(sampleRate * 0.02)); // bloques de 20 ms: respuesta casi inmediata
    this.buf = new Float32Array(this.size);
    this.pos = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.tau === 'number') this.setTau(e.data.tau);
    };
  }

  setTau(t) {
    this.alpha = 1 - Math.exp(-1 / (t * sampleRate));
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;
    const x = inp[0];
    const sos = this.sos, z = this.z, ns = sos.length, alpha = this.alpha, size = this.size;
    let msZ = this.msZ, msA = this.msA, sumZ = this.sumZ, sumA = this.sumA, peak = this.peak;
    let pos = this.pos, buf = this.buf;

    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      let y = v;
      for (let s = 0; s < ns; s++) {
        const c = sos[s], st = z[s];
        const o = c.b0 * y + st[0];
        st[0] = c.b1 * y - c.a1 * o + st[1];
        st[1] = c.b2 * y - c.a2 * o;
        y = o;
      }
      const v2 = v * v, y2 = y * y;
      msZ += alpha * (v2 - msZ);
      msA += alpha * (y2 - msA);
      sumZ += v2;
      sumA += y2;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      buf[pos++] = v;
      if (pos === size) {
        this.port.postMessage(
          { samples: buf, msZ, msA, leqZ: sumZ / size, leqA: sumA / size, peak },
          [buf.buffer]
        );
        buf = new Float32Array(size);
        pos = 0; sumZ = 0; sumA = 0; peak = 0;
      }
    }
    this.msZ = msZ; this.msA = msA; this.sumZ = sumZ; this.sumA = sumA;
    this.peak = peak; this.pos = pos; this.buf = buf;
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);

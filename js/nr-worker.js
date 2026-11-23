// Worker para la reducción de ruido: evita bloquear la pantalla con grabaciones largas.
import { denoise } from './dsp.js';

self.onmessage = (e) => {
  const { id, samples, fs, noise, params } = e.data;
  try {
    const out = denoise(samples, fs, { noise, ...params });
    self.postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};

# Sonómetro

Medidor de decibelios y grabadora de sonidos para el móvil, en una web app que funciona en el navegador (y sin conexión una vez abierta).

**Abrir la app:** https://caorjavier.github.io/sonometro/

Para probarla sin micrófono (en el ordenador, por ejemplo) hay un modo de demostración con sonido simulado: https://caorjavier.github.io/sonometro/?demo

## Qué hace

- **¿Supera el límite legal?** Compara en directo la media de 5 s en dB(A) con el límite del momento (día 7–19 h, tarde 19–23 h, noche 23–7 h) para un dormitorio o un salón, según los valores orientativos del Real Decreto 1367/2007 (tabla B2), o con límites personalizados. Cuenta las veces que se supera.
- **Restar el ruido de fondo**: mide el fondo en silencio (mediana de 10 s) y resta su energía, como en las mediciones técnicas, para contar solo el ruido que sobresale. Así desaparecen los 25–35 dB que el móvil capta siempre.
- **Medidor en tiempo real** (bloques de 20 ms) en dB(A) o dB(Z), con respuesta instantánea (35 ms), rápida (125 ms) o lenta (1 s), mínimo, media (Leq) y máximo.
- **Onda en vivo**: últimos 10 s desplazándose (en rojo lo que se graba) u osciloscopio con la forma real de la onda.
- Lo importante cabe en **una sola pantalla** del móvil, sin deslizar.
- **Grabación automática** al superar el límite legal o un umbral propio: guarda también los **segundos anteriores** (0–5 s, la app los mantiene siempre en memoria) y sigue grabando **mientras dura** el sonido y los **segundos posteriores** elegidos (0–5 s).
- **Grabación manual** con un botón (incluye también los segundos previos).
- **Quitar ruido**:
  - filtro de **zumbido eléctrico** de 50 o 60 Hz y sus armónicos,
  - filtros de **graves** (viento, retumbos) y **agudos** (siseo),
  - **reducción de ruido de fondo** espectral, automática o con un perfil de ruido aprendido (ventiladores, nevera, aire acondicionado…). Se puede aplicar al guardar o después, creando una copia limpia.
- **Historial** de nivel con las grabaciones marcadas y **espectro** con la frecuencia dominante.
- **Lista de grabaciones** con duración, máximo, media y pico; escuchar, descargar en WAV, compartir y exportar un **registro CSV** de todos los eventos.
- **Calibración** contra un sonómetro de referencia.
- **Instrucciones** para colocar el móvil, dejarlo escuchando durante horas, instalarlo como app, dar permiso al micrófono y calibrar.
- Mantiene la **pantalla encendida** mientras escucha y avisa si hubo ratos sin escuchar (por ejemplo, si la app pasó a segundo plano).

Todo se procesa y se guarda **solo en el dispositivo** (IndexedDB). No hay servidor.

## Cómo está hecha

HTML, CSS y JavaScript sin dependencias ni compilación.

| Archivo | Qué contiene |
| --- | --- |
| `index.html` | Interfaz: Medidor, Grabaciones, Ajustes y Ayuda |
| `js/app.js` | Lógica de la app: audio, disparo por umbral, búfer previo, interfaz |
| `js/worklet.js` | AudioWorklet que mide el nivel con ponderación A (IEC 61672) y envía bloques de 50 ms |
| `js/dsp.js` | FFT, reducción de ruido por sustracción espectral, WAV |
| `js/nr-worker.js` | Web Worker para limpiar el ruido sin bloquear la pantalla |
| `js/db.js` | Almacenamiento de grabaciones en IndexedDB |
| `sw.js`, `manifest.webmanifest` | Funcionamiento sin conexión e instalación como app |

Para probarla en local hace falta servirla por HTTP (el micrófono solo funciona en `https` o `localhost`):

```
python -m http.server 8765
```

y abrir http://localhost:8765

## Limitaciones

- Un móvil no es un sonómetro homologado: calibrado, la precisión típica es de ±2–5 dB. Sus mediciones no sirven como prueba oficial, pero el registro ayuda a pedir una medición al ayuntamiento o a la policía local.
- Muchos móviles no distinguen sonidos por debajo de unos 30 dB(A) por el ruido propio del micrófono, así que de noche en un dormitorio (límite 25 dB(A)) solo pueden confirmar superaciones claras.
- Los navegadores móviles cortan el micrófono cuando la página pasa a segundo plano o se bloquea la pantalla: hay que dejarla abierta y con la pantalla encendida.

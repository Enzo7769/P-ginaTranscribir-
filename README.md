# Transcriptor de audio

Página web para transcribir audio y vídeo a texto con la máxima precisión posible. Es una página estática: no necesita servidor ni instalación, y no guarda tus audios en ningún sitio.

## Motores

| Motor | Precisión | Coste | Privacidad | Extras |
|---|---|---|---|---|
| **ElevenLabs Scribe v2** | Máxima | De pago (API key) | El audio va a ElevenLabs | Hablantes, eventos de audio (risas, música…), términos clave |
| **OpenAI gpt-4o-transcribe** | Muy alta | De pago (API key) | El audio va a OpenAI | Hablantes con `gpt-4o-transcribe-diarize`, vocabulario |
| **Groq Whisper large-v3** | Alta | Capa gratuita (API key) | El audio va a Groq | Muy rápido, marcas de tiempo, vocabulario |
| **Local: Whisper large-v3-turbo** | Alta | Gratis | **El audio no sale de tu equipo** | Funciona sin cuenta; usa la GPU (WebGPU) si está disponible |

## Funciones

- Subir archivos (MP3, WAV, M4A, OGG, FLAC, WEBM, MP4, MOV…) arrastrándolos o grabar directamente con el micrófono.
- Elegir idioma (mejora la precisión) y añadir vocabulario: nombres propios, siglas o términos técnicos.
- Identificación de hablantes (ElevenLabs y OpenAI).
- Audios largos: se trocean automáticamente en los silencios para no cortar palabras, y cada trozo recibe el final del anterior como contexto.
- Vista por segmentos con marcas de tiempo: haz clic para escuchar ese momento; el segmento actual se resalta mientras suena el audio.
- Texto editable, copiar y descargar en TXT, TXT con tiempos, SRT, VTT, Word (.doc) y JSON.
- Historial de transcripciones guardado solo en tu navegador.
- Tema claro/oscuro y diseño adaptado a móvil.

## Cómo usarla

Abre `index.html` desde un servidor web (los módulos de JavaScript no funcionan abriendo el archivo con doble clic):

```bash
python3 -m http.server 8000
# y abre http://localhost:8000
```

### Publicarla gratis con GitHub Pages

1. En GitHub ve a **Settings → Pages**.
2. En *Source* elige **Deploy from a branch**, selecciona la rama y la carpeta `/ (root)` y guarda.
3. En un minuto estará en `https://<tu-usuario>.github.io/P-ginaTranscribir-/`.

La grabación con micrófono y WebGPU requieren HTTPS (GitHub Pages ya lo tiene) o `localhost`.

## API keys

- ElevenLabs: <https://elevenlabs.io/app/settings/api-keys> (con permiso de Speech to Text)
- OpenAI: <https://platform.openai.com/api-keys>
- Groq: <https://console.groq.com/keys>

Las claves se guardan solo en tu navegador (puedes desactivarlo) y se envían directamente al proveedor elegido.

## Consejos para máxima precisión

1. Usa ElevenLabs Scribe v2 u OpenAI `gpt-4o-transcribe`.
2. Selecciona el idioma en lugar de «Detectar automáticamente».
3. Escribe en «Vocabulario» los nombres y términos poco comunes que aparecen en el audio.
4. Graba con el micrófono cerca, en un sitio sin eco ni ruido de fondo.

## Estructura

```
index.html            Interfaz
css/styles.css        Estilos (tema claro/oscuro)
js/app.js             Lógica de la interfaz, grabación, historial
js/engines.js         Motores: local, OpenAI/Groq, ElevenLabs
js/whisper-worker.js  Whisper en el navegador (Transformers.js) en un Web Worker
js/audio.js           Decodificación a 16 kHz, troceado en silencios, WAV
js/export.js          Exportación a TXT, SRT, VTT, Word y JSON
```

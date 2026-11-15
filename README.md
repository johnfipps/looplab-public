# LoopLab!

A browser-based step sequencer for making beats in the music classroom. Choose **Load Demo Song** to hear HippoHoppo.

## Run locally

With Node.js installed, run:

```sh
npx --yes http-server dist -a 127.0.0.1 -p 8080
```

Open http://localhost:8080 in Chrome. Use localhost for local Web MIDI and service worker support. Project saves live in your browser. Use **Save Project** to keep a portable copy.

## Test

```sh
npm test
```

The static site lives in `dist/`. No build step is required. The bundled MP3 encoder's license and notices live in `dist/vendor/`.

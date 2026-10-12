# bpm-key-detect

**Tempo and musical key detection from raw PCM. Zero dependencies, runs in the
browser and in Node.**

Give it Float32 audio samples and a sample rate; get back BPM, musical key,
[Camelot notation](https://en.wikipedia.org/wiki/Harmonic_mixing#Camelot_wheel),
and a confidence rating for each. No native modules, no WASM, no model
download, no network.

Not on the npm registry — install it straight from GitHub:

```bash
npm install github:Utilumo/bpm-key-detect
```

`dist/` is not committed, so the package builds itself on install via its
`prepare` script. Works with npm, pnpm and yarn; Bun needs `bun add
github:Utilumo/bpm-key-detect`. To pin a version, append a tag: `#v0.1.0`.

Extracted from the [Song Analyzer](https://utilumo.com/audio/song-analyzer) on
[Utilumo](https://utilumo.com), where it runs in a Web Worker in the browser and
no audio is uploaded anywhere.

## Why this exists

Most tempo and key detection is either a server API you upload your audio to, or
a native/WASM binding that will not run where you need it. This is plain
TypeScript doing the DSP itself, so the same code runs in a browser tab, a Web
Worker, Node, Deno, Bun or a Cloudflare Worker — and your audio never has to
leave the process that decoded it.

## Usage

Decoding is your job: this library takes samples, not files. In the browser the
decoder is already there.

```js
import { analyzeAudioSamples } from "bpm-key-detect";

const context = new AudioContext();
const buffer = await context.decodeAudioData(await file.arrayBuffer());

const result = analyzeAudioSamples({
  samples: buffer.getChannelData(0),
  sampleRate: buffer.sampleRate,
  channels: buffer.numberOfChannels,
  durationSeconds: buffer.duration,
  fileSize: file.size, // optional, only used to report a bitrate
  fileType: file.type, // optional
});

console.log(result.tempo.bpm, result.key.label, result.key.camelot);
```

In Node, decode with whatever you already have — `ffmpeg` to raw `f32le`, a WAV
reader, `node-web-audio-api`:

```js
import { execFileSync } from "node:child_process";
import { analyzeAudioSamples } from "bpm-key-detect";

const sampleRate = 22050;
const raw = execFileSync("ffmpeg", [
  "-i", "track.mp3", "-f", "f32le", "-ac", "1", "-ar", String(sampleRate), "-",
], { maxBuffer: 1 << 28 });

const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

const result = analyzeAudioSamples({
  samples,
  sampleRate,
  channels: 1,
  durationSeconds: samples.length / sampleRate,
});
```

Running the analysis off the main thread in a browser is a normal worker — the
library has no globals and no side effects, so just import it inside the worker:

```js
// worker.js
import { analyzeAudioSamples } from "bpm-key-detect";

self.addEventListener("message", (event) => {
  self.postMessage({ result: analyzeAudioSamples(event.data) });
});
```

`Float32Array` is transferable, so pass `samples.buffer` in the transfer list to
avoid copying it.

## What you get back

A real result, from the click track plus F♯-minor triad used in the test suite
(24 s at 11 025 Hz, generated at 120 BPM):

```json
{
  "tempo": {
    "bpm": 118.4,
    "confidence": "high",
    "confidenceLabel": "Very confident",
    "confidencePercent": 100,
    "stability": "high",
    "alternatives": [{ "bpm": 59.2, "label": "Half-time" }],
    "detail": "Tempo is estimated from repeated energy changes in the audio."
  },
  "key": {
    "tonic": "F#",
    "mode": "minor",
    "label": "F# Minor",
    "camelot": "11A",
    "relativeKey": "A Major",
    "relativeCamelot": "11B",
    "confidence": "high",
    "confidenceLabel": "Confident",
    "confidencePercent": 83,
    "alternatives": [
      { "tonic": "F#", "mode": "major", "label": "F# Major", "camelot": "2B", "confidencePercent": 42 }
    ],
    "detail": "Key is estimated from chroma energy against major and minor key profiles."
  },
  "metadata": {
    "sampleRate": 11025,
    "channels": 2,
    "durationSeconds": 24,
    "fileSize": 5292000,
    "fileType": "audio/wav",
    "bitrateKbps": 1764
  },
  "notices": []
}
```

118.4 against a generated 120 is the resolution of the onset hop at that sample
rate, not a disagreement about the beat. The key is exact.

Two fields are worth reading before you render anything:

- **`alternatives`** on `tempo` is the half-time / double-time reading. Tempo
  detection is ambiguous by an octave on a lot of material, and on a uniform
  metronome with no beat emphasis it can lock to the wrong one outright. Show
  the alternative rather than pretending there is only one answer.
- **`notices`** is a list of plain-language caveats the analysis wants
  surfaced — low tempo confidence, low key confidence. Empty when there are
  none.

## API

| Export | Signature |
|---|---|
| `analyzeAudioSamples` | `(input: AudioAnalysisInput) => SongAnalysisResult` — tempo, key, metadata and notices in one pass |
| `estimateTempoFromPcm` | `(samples: Float32Array, sampleRate: number) => TempoAnalysis` |
| `estimateKeyFromPcm` | `(samples: Float32Array, sampleRate: number) => MusicalKeyAnalysis` |
| `getCamelotCode` | `(tonic: string, mode: MusicalMode) => string \| null` |
| `getRelativeKey` | `(tonic: string, mode: MusicalMode) => string \| null` |
| `getRelativeCamelotCode` | `(tonic: string, mode: MusicalMode) => string \| null` |
| `getConfidenceRating` | `(percent: number) => { label, percent }` — the readable label for a confidence percentage |

`AudioAnalysisInput` needs `samples`, `sampleRate`, `channels` and
`durationSeconds`. `fileSize`, `fileType` and `sourceSampleRate` are optional
and only shape the reported `metadata` — pass `sourceSampleRate` when you
downsampled before analysis and want the original rate reported.

Every type is exported: `TempoAnalysis`, `MusicalKeyAnalysis`, `AudioMetadata`,
`SongAnalysisResult`, `AudioAnalysisInput`, `TempoAlternative`,
`MusicalKeyAlternative`, `MusicalMode`, `AudioAnalysisConfidence`,
`AudioConfidenceLabel`.

## How it works

**Tempo.** The signal is reduced to short-time energy frames (~23 ms hop), then
to a half-wave-rectified onset envelope — frame-to-frame energy *increases*
only, which is what a percussive attack looks like and what sustained tone does
not. Autocorrelating that envelope over the lag range that corresponds to
60–220 BPM gives a set of candidate periods; the strongest peak becomes the BPM,
and its separation from the next distinct peak becomes the confidence. Peaks
within a couple of lags of the winner are treated as the same peak rather than
as competition.

**Key.** A Goertzel filter measures power at each semitone across several
octaves — cheaper than a full FFT when you only want 12 pitch classes. Those
fold into a 12-bin chroma vector, which is compared by cosine similarity against
major and minor key profiles rotated over all 12 tonics. The best match is the
key; the gap to the runner-up is the confidence. Camelot is a lookup from the
resulting tonic and mode.

**Cost control.** Tempo looks at the first 60 s and key at the first 45 s, which
is enough for both and keeps a long file from being quadratic in nothing useful.
Analysis is happiest around 11–22 kHz; downsample before calling and pass
`sourceSampleRate` so the metadata still reports the real rate.

## Accuracy, honestly

This is signal processing, not a model, and it does not claim to be right.

- **Clear, steady, percussive material** reads well — house, techno, hip-hop,
  most pop.
- **Tempo is octave-ambiguous.** Expect half or double on material without
  strong beat emphasis. That is what `alternatives` is for.
- **Key detection is the weaker half.** Chord changes, modulation, non-standard
  tuning, heavy processing and sparse arrangements all degrade it. Treat it as a
  starting point.
- **Ambient, spoken, rubato and tempo-changing audio** will often return
  `bpm: null` with a `detail` explaining why. That is the intended answer, not
  a failure — it says so rather than guessing.

The confidence fields are not decoration. If you are building a UI, show them.

## Tests

```bash
npm install
npm test
```

18 cases over synthetic click tracks, tonal content, clipped peaks,
browser-resampled PCM, competing rhythmic layers, silence and empty buffers.
Correctness assertions are ranges, because the honest claim is "close", not
"exact".

## Related

- [Song Analyzer](https://utilumo.com/audio/song-analyzer) — this library with a
  UI, running in your browser
- [Utilumo Stack](https://github.com/Utilumo/utilumo-stack) — what the rest of
  the browser-local tooling is built on

## License

MIT

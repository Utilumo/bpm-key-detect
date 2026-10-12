/**
 * bpm-key-detect — tempo and musical key detection from raw PCM.
 *
 * Tempo: short-time energy frames -> half-wave-rectified onset envelope ->
 * autocorrelation over the plausible BPM range, with octave disambiguation.
 * Key: Goertzel power per semitone -> 12-bin chroma vector -> cosine similarity
 * against Krumhansl-style major and minor profiles, rotated over all 12 tonics.
 *
 * No dependencies, no I/O, no global state. Decoding is the caller's job: feed
 * mono or interleaved Float32 PCM and the sample rate it was decoded at.
 */

export type AudioAnalysisConfidence = "high" | "medium" | "low";
export type AudioConfidenceLabel =
  | "Very confident"
  | "Confident"
  | "Moderate"
  | "Low confidence";
export type MusicalMode = "major" | "minor";

export type TempoAlternative = {
  bpm: number;
  label: "Half-time" | "Double-time";
};

export type TempoAnalysis = {
  alternatives: TempoAlternative[];
  bpm: number | null;
  confidence: AudioAnalysisConfidence;
  confidenceLabel: AudioConfidenceLabel;
  confidencePercent: number;
  detail: string;
  stability: AudioAnalysisConfidence;
};

export type MusicalKeyAlternative = {
  camelot: string | null;
  confidencePercent: number;
  label: string;
  mode: MusicalMode;
  tonic: string;
};

export type MusicalKeyAnalysis = {
  alternatives: MusicalKeyAlternative[];
  camelot: string | null;
  confidence: AudioAnalysisConfidence;
  confidenceLabel: AudioConfidenceLabel;
  confidencePercent: number;
  detail: string;
  label: string;
  mode: MusicalMode | null;
  relativeCamelot: string | null;
  relativeKey: string | null;
  tonic: string | null;
};

export type AudioMetadata = {
  bitrateKbps: number | null;
  channels: number;
  durationSeconds: number;
  fileSize: number;
  fileType: string;
  sampleRate: number;
};

export type AudioAnalysisInput = {
  channels: number;
  durationSeconds: number;
  fileSize?: number;
  fileType?: string;
  samples: Float32Array;
  sampleRate: number;
  sourceSampleRate?: number;
};

export type SongAnalysisResult = {
  key: MusicalKeyAnalysis;
  metadata: AudioMetadata;
  notices: string[];
  tempo: TempoAnalysis;
};

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const ENHARMONIC_NOTES: Record<string, (typeof NOTE_NAMES)[number]> = {
  A: "A",
  "A#": "A#",
  AB: "G#",
  B: "B",
  BB: "A#",
  C: "C",
  "C#": "C#",
  CB: "B",
  D: "D",
  "D#": "D#",
  DB: "C#",
  E: "E",
  EB: "D#",
  F: "F",
  "F#": "F#",
  FB: "E",
  G: "G",
  "G#": "G#",
  GB: "F#",
};

const CAMELOT_MINOR: Record<(typeof NOTE_NAMES)[number], string> = {
  "G#": "1A",
  "D#": "2A",
  "A#": "3A",
  F: "4A",
  C: "5A",
  G: "6A",
  D: "7A",
  A: "8A",
  E: "9A",
  B: "10A",
  "F#": "11A",
  "C#": "12A",
};

const CAMELOT_MAJOR: Record<(typeof NOTE_NAMES)[number], string> = {
  B: "1B",
  "F#": "2B",
  "C#": "3B",
  "G#": "4B",
  "D#": "5B",
  "A#": "6B",
  F: "7B",
  C: "8B",
  G: "9B",
  D: "10B",
  A: "11B",
  E: "12B",
};

const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const MIN_BPM = 60;
const MAX_BPM = 200;
const MAX_TEMPO_SECONDS = 180;
const MAX_KEY_SECONDS = 75;
const TEMPO_HOP_SECONDS = 0.023;

function normalizeNoteName(tonic: string) {
  const key = tonic.trim().toUpperCase().replace("♯", "#").replace("♭", "B");

  return ENHARMONIC_NOTES[key] ?? null;
}

function noteIndex(note: string) {
  const normalized = normalizeNoteName(note);

  return normalized ? NOTE_NAMES.indexOf(normalized) : -1;
}

function noteNameFromIndex(index: number) {
  return NOTE_NAMES[((index % 12) + 12) % 12];
}

function formatKey(tonic: string, mode: MusicalMode) {
  return `${tonic} ${mode === "major" ? "Major" : "Minor"}`;
}

function roundBpm(value: number) {
  return Math.round(value * 10) / 10;
}

function clampConfidencePercent(value: number) {
  if (!Number.isFinite(value)) return 0;

  return Math.max(0, Math.min(100, Math.round(value)));
}

export function getConfidenceRating(percent: number) {
  const normalized = clampConfidencePercent(percent);

  if (normalized >= 90) {
    return { label: "Very confident" as const, percent: normalized };
  }

  if (normalized >= 70) {
    return { label: "Confident" as const, percent: normalized };
  }

  if (normalized >= 50) {
    return { label: "Moderate" as const, percent: normalized };
  }

  return { label: "Low confidence" as const, percent: normalized };
}

function confidenceBucketFromPercent(percent: number): AudioAnalysisConfidence {
  if (percent >= 70) return "high";
  if (percent >= 50) return "medium";

  return "low";
}

function getBitrateKbps(fileSize: number, durationSeconds: number) {
  if (fileSize <= 0 || durationSeconds <= 0) return null;

  return Math.round((fileSize * 8) / durationSeconds / 1000);
}

function clampAnalysisSamples(
  samples: Float32Array,
  sampleRate: number,
  maxSeconds: number,
) {
  const maxLength = Math.min(samples.length, Math.floor(sampleRate * maxSeconds));

  return samples.subarray(0, maxLength);
}

function getRms(values: Float32Array) {
  if (values.length === 0) return 0;

  let energy = 0;
  for (let index = 0; index < values.length; index += 1) {
    const sample = values[index] ?? 0;
    energy += sample * sample;
  }

  return Math.sqrt(energy / values.length);
}

function createOnsetEnvelope(samples: Float32Array, sampleRate: number) {
  const hopSize = Math.max(128, Math.round(sampleRate * TEMPO_HOP_SECONDS));
  const frameCount = Math.floor(samples.length / hopSize);
  const energies = new Float64Array(frameCount);
  const envelope = new Float64Array(Math.max(0, frameCount - 1));

  for (let frame = 0; frame < frameCount; frame += 1) {
    let energy = 0;
    const start = frame * hopSize;
    const end = Math.min(samples.length, start + hopSize);

    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      energy += Math.abs(sample);
    }

    energies[frame] = energy / Math.max(1, end - start);
  }

  for (let frame = 1; frame < frameCount; frame += 1) {
    envelope[frame - 1] = Math.max(0, energies[frame] - energies[frame - 1]);
  }

  return { energies, envelope, hopSize };
}

function autocorrelateTempo(
  envelope: Float64Array,
  hopSize: number,
  sampleRate: number,
) {
  const lagMin = Math.max(1, Math.floor((60 / MAX_BPM) * (sampleRate / hopSize)));
  const lagMax = Math.max(
    lagMin + 1,
    Math.ceil((60 / MIN_BPM) * (sampleRate / hopSize)),
  );
  const scores: { lag: number; score: number }[] = [];

  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let sum = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;

    for (let index = lag; index < envelope.length; index += 1) {
      const left = envelope[index] ?? 0;
      const right = envelope[index - lag] ?? 0;
      sum += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }

    const score = sum / Math.sqrt(Math.max(leftEnergy * rightEnergy, 1e-12));
    scores.push({ lag, score });
  }

  scores.sort((left, right) => right.score - left.score);

  return scores;
}

function confidencePercentFromTempo(score: number, separation: number) {
  let percent = score * 200;

  if (separation < 1.05) {
    percent = Math.min(percent, 69);
  } else if (separation < 1.15) {
    percent = Math.min(percent, 89);
  }

  return clampConfidencePercent(percent);
}

function createTempoAlternatives(bpm: number) {
  const alternatives: TempoAlternative[] = [];

  if (bpm >= 100) {
    alternatives.push({ bpm: roundBpm(bpm / 2), label: "Half-time" });
  }

  if (bpm <= 115 && bpm * 2 <= 220) {
    alternatives.push({ bpm: roundBpm(bpm * 2), label: "Double-time" });
  }

  return alternatives;
}

export function estimateTempoFromPcm(
  samples: Float32Array,
  sampleRate: number,
): TempoAnalysis {
  const analysisSamples = clampAnalysisSamples(
    samples,
    sampleRate,
    MAX_TEMPO_SECONDS,
  );
  const rms = getRms(analysisSamples);

  if (analysisSamples.length < sampleRate * 3 || rms < 0.002) {
    return {
      alternatives: [],
      bpm: null,
      confidence: "low",
      confidenceLabel: "Low confidence",
      confidencePercent: 0,
      detail: "Not enough rhythmic signal was found for a useful BPM estimate.",
      stability: "low",
    };
  }

  const { energies, envelope, hopSize } = createOnsetEnvelope(
    analysisSamples,
    sampleRate,
  );
  const onsetEnergy = envelope.reduce((total, value) => total + value, 0);
  const frameEnergy = energies.reduce((total, value) => total + value, 0);

  if (onsetEnergy < 0.001 || onsetEnergy / Math.max(frameEnergy, 1e-9) < 0.02) {
    return {
      alternatives: [],
      bpm: null,
      confidence: "low",
      confidenceLabel: "Low confidence",
      confidencePercent: 0,
      detail: "The audio does not have clear beat onsets.",
      stability: "low",
    };
  }

  const scores = autocorrelateTempo(envelope, hopSize, sampleRate);
  const best = scores[0];

  if (!best) {
    return {
      alternatives: [],
      bpm: null,
      confidence: "low",
      confidenceLabel: "Low confidence",
      confidencePercent: 0,
      detail: "A tempo peak could not be separated from the rhythm envelope.",
      stability: "low",
    };
  }

  const nextDistinct = scores.find((score) => Math.abs(score.lag - best.lag) > 2);
  const separation = nextDistinct
    ? best.score / Math.max(nextDistinct.score, 1e-6)
    : 1;
  const secondsPerLag = hopSize / sampleRate;
  const bpm = roundBpm(60 / (best.lag * secondsPerLag));
  const confidencePercent = confidencePercentFromTempo(best.score, separation);
  const confidenceRating = getConfidenceRating(confidencePercent);
  const confidence = confidenceBucketFromPercent(confidencePercent);
  const stability =
    confidence === "high" ? "high" : confidence === "medium" ? "medium" : "low";

  return {
    alternatives: createTempoAlternatives(bpm),
    bpm,
    confidence,
    confidenceLabel: confidenceRating.label,
    confidencePercent,
    detail:
      confidence === "low"
        ? "Tempo confidence is low; use the result as a rough estimate."
        : "Tempo is estimated from repeated energy changes in the audio.",
    stability,
  };
}

function goertzelPower(
  samples: Float32Array,
  start: number,
  length: number,
  sampleRate: number,
  frequency: number,
) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let previous = 0;
  let previous2 = 0;

  for (let offset = 0; offset < length; offset += 1) {
    const index = start + offset;
    const window =
      0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / Math.max(1, length - 1));
    const current = (samples[index] ?? 0) * window + coeff * previous - previous2;
    previous2 = previous;
    previous = current;
  }

  return previous2 * previous2 + previous * previous - coeff * previous * previous2;
}

function createChroma(samples: Float32Array, sampleRate: number) {
  const analysisSamples = clampAnalysisSamples(
    samples,
    sampleRate,
    MAX_KEY_SECONDS,
  );
  const chroma = new Float64Array(12);
  const frameSize = Math.min(4096, analysisSamples.length);
  const hopSize = Math.max(1024, Math.floor(frameSize / 2));

  if (frameSize < 1024) return chroma;

  for (
    let start = 0;
    start + frameSize <= analysisSamples.length;
    start += hopSize
  ) {
    for (let midi = 36; midi <= 84; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const power = goertzelPower(
        analysisSamples,
        start,
        frameSize,
        sampleRate,
        frequency,
      );
      chroma[midi % 12] += Math.sqrt(Math.max(0, power));
    }
  }

  return chroma;
}

function cosineSimilarity(
  chroma: Float64Array,
  profile: number[],
  tonicIndex: number,
) {
  let dot = 0;
  let chromaEnergy = 0;
  let profileEnergy = 0;

  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    const profileValue = profile[(pitchClass - tonicIndex + 12) % 12] ?? 0;
    const chromaValue = chroma[pitchClass] ?? 0;
    dot += chromaValue * profileValue;
    chromaEnergy += chromaValue * chromaValue;
    profileEnergy += profileValue * profileValue;
  }

  return dot / Math.sqrt(Math.max(chromaEnergy * profileEnergy, 1e-12));
}

function confidencePercentFromKey(bestScore: number, secondScore: number) {
  const gap = bestScore - secondScore;
  let percent = bestScore * 45 + gap * 900;

  if (bestScore < 0.62 || gap < 0.01) {
    percent = Math.min(percent, 49);
  }

  return clampConfidencePercent(percent);
}

function getAlternativeKeyConfidencePercent(score: number, bestScore: number) {
  if (bestScore <= 0) return 0;

  return clampConfidencePercent((score / bestScore) * 45);
}

export function getCamelotCode(tonic: string, mode: MusicalMode) {
  const normalized = normalizeNoteName(tonic);
  if (!normalized) return null;

  return mode === "major" ? CAMELOT_MAJOR[normalized] : CAMELOT_MINOR[normalized];
}

export function getRelativeKey(tonic: string, mode: MusicalMode) {
  const index = noteIndex(tonic);
  if (index < 0) return null;

  const relativeIndex = mode === "major" ? index - 3 : index + 3;
  const relativeMode = mode === "major" ? "minor" : "major";

  return formatKey(noteNameFromIndex(relativeIndex), relativeMode);
}

export function getRelativeCamelotCode(tonic: string, mode: MusicalMode) {
  const camelot = getCamelotCode(tonic, mode);
  if (!camelot) return null;

  return `${camelot.slice(0, -1)}${mode === "major" ? "A" : "B"}`;
}

export function estimateKeyFromPcm(
  samples: Float32Array,
  sampleRate: number,
): MusicalKeyAnalysis {
  const chroma = createChroma(samples, sampleRate);
  const totalChroma = chroma.reduce((total, value) => total + value, 0);

  if (totalChroma <= 1e-6) {
    return {
      alternatives: [],
      camelot: null,
      confidence: "low",
      confidenceLabel: "Low confidence",
      confidencePercent: 0,
      detail: "Not enough tonal signal was found for a useful key estimate.",
      label: "Unknown",
      mode: null,
      relativeCamelot: null,
      relativeKey: null,
      tonic: null,
    };
  }

  const candidates: {
    mode: MusicalMode;
    score: number;
    tonic: (typeof NOTE_NAMES)[number];
  }[] = [];

  for (let tonicIndex = 0; tonicIndex < 12; tonicIndex += 1) {
    candidates.push({
      mode: "major",
      score: cosineSimilarity(chroma, MAJOR_PROFILE, tonicIndex),
      tonic: NOTE_NAMES[tonicIndex],
    });
    candidates.push({
      mode: "minor",
      score: cosineSimilarity(chroma, MINOR_PROFILE, tonicIndex),
      tonic: NOTE_NAMES[tonicIndex],
    });
  }

  candidates.sort((left, right) => right.score - left.score);

  const best = candidates[0];
  const second = candidates[1];

  if (!best) {
    return {
      alternatives: [],
      camelot: null,
      confidence: "low",
      confidenceLabel: "Low confidence",
      confidencePercent: 0,
      detail: "A musical key could not be estimated.",
      label: "Unknown",
      mode: null,
      relativeCamelot: null,
      relativeKey: null,
      tonic: null,
    };
  }

  const confidencePercent = confidencePercentFromKey(best.score, second?.score ?? 0);
  const confidenceRating = getConfidenceRating(confidencePercent);
  const confidence = confidenceBucketFromPercent(confidencePercent);
  const label = formatKey(best.tonic, best.mode);
  const alternatives = candidates
    .slice(1, 4)
    .map((candidate) => ({
      camelot: getCamelotCode(candidate.tonic, candidate.mode),
      confidencePercent: getAlternativeKeyConfidencePercent(
        candidate.score,
        best.score,
      ),
      label: formatKey(candidate.tonic, candidate.mode),
      mode: candidate.mode,
      tonic: candidate.tonic,
    }));

  return {
    alternatives,
    camelot: getCamelotCode(best.tonic, best.mode),
    confidence,
    confidenceLabel: confidenceRating.label,
    confidencePercent,
    detail:
      confidence === "low"
        ? "Key confidence is low. Chords, key changes, tuning, and sparse audio can affect this estimate."
        : "Key is estimated from chroma energy against major and minor key profiles.",
    label,
    mode: best.mode,
    relativeCamelot: getRelativeCamelotCode(best.tonic, best.mode),
    relativeKey: getRelativeKey(best.tonic, best.mode),
    tonic: best.tonic,
  };
}

export function analyzeAudioSamples(input: AudioAnalysisInput): SongAnalysisResult {
  const tempo = estimateTempoFromPcm(input.samples, input.sampleRate);
  const key = estimateKeyFromPcm(input.samples, input.sampleRate);
  const notices: string[] = [];

  if (tempo.confidence === "low") {
    notices.push(
      "Tempo confidence is low. Sparse, ambient, spoken, or tempo-changing audio can be hard to read.",
    );
  }

  if (key.confidence === "low") {
    notices.push(
      "Key detection confidence is low. Treat the key as a starting point, not a verified fact.",
    );
  }

  return {
    key,
    metadata: {
      bitrateKbps: getBitrateKbps(input.fileSize ?? 0, input.durationSeconds),
      channels: input.channels,
      durationSeconds: input.durationSeconds,
      fileSize: input.fileSize ?? 0,
      fileType: input.fileType ?? "Unknown",
      sampleRate: input.sourceSampleRate ?? input.sampleRate,
    },
    notices,
    tempo,
  };
}

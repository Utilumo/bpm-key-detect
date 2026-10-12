import { describe, expect, it } from "vitest";
import {
  analyzeAudioSamples,
  getConfidenceRating,
  getCamelotCode,
  getRelativeCamelotCode,
  estimateKeyFromPcm,
  estimateTempoFromPcm,
  getRelativeKey,
} from "./index.js";

function createClickTrack({
  bpm,
  durationSeconds,
  sampleRate,
}: {
  bpm: number;
  durationSeconds: number;
  sampleRate: number;
}) {
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  const beatInterval = 60 / bpm;

  for (let beat = 0; beat * beatInterval < durationSeconds; beat += 1) {
    const start = Math.round(beat * beatInterval * sampleRate);

    for (let offset = 0; offset < Math.round(sampleRate * 0.018); offset += 1) {
      const index = start + offset;
      if (index >= samples.length) break;
      samples[index] = Math.max(samples[index], 1 - offset / (sampleRate * 0.018));
    }
  }

  return samples;
}

function addTone(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
  gain: number,
) {
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] +=
      Math.sin((Math.PI * 2 * frequency * index) / sampleRate) * gain;
  }
}

function downsample(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number) {
  const output = new Float32Array(Math.floor((samples.length / sourceSampleRate) * targetSampleRate));

  for (let index = 0; index < output.length; index += 1) {
    output[index] =
      samples[Math.min(samples.length - 1, Math.floor((index / targetSampleRate) * sourceSampleRate))] ?? 0;
  }

  return output;
}

function createLayeredEnergyPulseTrack(sampleRate: number) {
  const hopSize = Math.round(sampleRate * 0.023);
  const frameCount = 3600;
  const amplitudes = new Float32Array(frameCount);
  const samples = new Float32Array(frameCount * hopSize);
  let seed = 1;
  let floor = 0.02;

  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    floor = floor * 0.92 + 0.015 * random();
    amplitudes[frame] = floor;
  }

  for (let frame = 0; frame < frameCount; frame += 36) {
    amplitudes[frame] += 0.6 * (0.8 + 0.4 * random());
  }

  for (let frame = 0; frame < frameCount; frame += 28) {
    amplitudes[frame] += 0.6 * (0.8 + 0.4 * random());
  }

  for (let frame = 9; frame < frameCount; frame += 18) {
    amplitudes[frame] += 0.2 * (0.8 + 0.4 * random());
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const amplitude = amplitudes[frame] ?? 0;
    samples.fill(Math.min(1, amplitude), frame * hopSize, (frame + 1) * hopSize);
  }

  return samples;
}

describe("bpm-key-detect", () => {
  it("maps a numeric confidence into a readable label", () => {
    expect(getConfidenceRating(94).label).toBe("Very confident");
    expect(getConfidenceRating(87).label).toBe("Confident");
    expect(getConfidenceRating(58).label).toBe("Moderate");
    expect(getConfidenceRating(40).label).toBe("Low confidence");
  });

  it("maps musical keys to Camelot notation", () => {
    expect(getCamelotCode("F#", "minor")).toBe("11A");
    expect(getCamelotCode("A", "major")).toBe("11B");
    expect(getCamelotCode("C", "major")).toBe("8B");
    expect(getRelativeCamelotCode("F#", "minor")).toBe("11B");
  });

  it("detects the dominant BPM from a click track", () => {
    const sampleRate = 11025;
    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 24,
      fileSize: 2_400_000,
      fileType: "audio/wav",
      samples: createClickTrack({ bpm: 120, durationSeconds: 24, sampleRate }),
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
    expect(result.tempo.alternatives.map((item) => item.label)).toContain(
      "Half-time",
    );
    expect(result.metadata.bitrateKbps).toBe(800);
  });

  it("keeps BPM close when a click track has tonal content", () => {
    const sampleRate = 11025;
    const samples = createClickTrack({
      bpm: 120,
      durationSeconds: 8,
      sampleRate,
    });

    addTone(samples, sampleRate, 185, 0.35);
    addTone(samples, sampleRate, 220, 0.18);
    addTone(samples, sampleRate, 277.18, 0.15);

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 8,
      fileSize: 705_600,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
  });

  it("keeps BPM close on decoded CD-rate song-like samples", () => {
    const sampleRate = 44100;
    const samples = createClickTrack({
      bpm: 120,
      durationSeconds: 8,
      sampleRate,
    });

    addTone(samples, sampleRate, 185, 0.35);
    addTone(samples, sampleRate, 220, 0.18);
    addTone(samples, sampleRate, 277.18, 0.15);

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 8,
      fileSize: 705_600,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
  });

  it("keeps BPM close on browser-resampled song-like samples", () => {
    const sampleRate = 48000;
    const samples = createClickTrack({
      bpm: 120,
      durationSeconds: 8,
      sampleRate,
    });

    addTone(samples, sampleRate, 185, 0.35);
    addTone(samples, sampleRate, 220, 0.18);
    addTone(samples, sampleRate, 277.18, 0.15);

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 8,
      fileSize: 705_600,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
  });

  it("keeps BPM close when browser-decoded PCM includes clipped peaks", () => {
    const sampleRate = 48000;
    const samples = createClickTrack({
      bpm: 120,
      durationSeconds: 8,
      sampleRate,
    });

    addTone(samples, sampleRate, 185, 0.35);
    addTone(samples, sampleRate, 220, 0.18);
    addTone(samples, sampleRate, 277.18, 0.15);

    for (let index = 0; index < samples.length; index += 1) {
      const clipped = Math.max(-1, Math.min(1, samples[index] ?? 0));
      samples[index] = Math.round(clipped * 32767) / 32767;
    }

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 8,
      fileSize: 705_600,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
  });

  it("keeps BPM close after analysis downsampling", () => {
    const sourceSampleRate = 48000;
    const targetSampleRate = 11025;
    const samples = createClickTrack({
      bpm: 120,
      durationSeconds: 8,
      sampleRate: sourceSampleRate,
    });

    addTone(samples, sourceSampleRate, 185, 0.35);
    addTone(samples, sourceSampleRate, 220, 0.18);
    addTone(samples, sourceSampleRate, 277.18, 0.15);

    for (let index = 0; index < samples.length; index += 1) {
      const clipped = Math.max(-1, Math.min(1, samples[index] ?? 0));
      samples[index] = Math.round(clipped * 32767) / 32767;
    }

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 8,
      fileSize: 705_600,
      fileType: "audio/wav",
      samples: downsample(samples, sourceSampleRate, targetSampleRate),
      sampleRate: targetSampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(118);
    expect(result.tempo.bpm).toBeLessThanOrEqual(122);
  });

  it("reports original sample rate when analysis uses downsampled PCM", () => {
    const sourceSampleRate = 44100;
    const targetSampleRate = 11025;
    const result = analyzeAudioSamples({
      channels: 2,
      durationSeconds: 12,
      fileSize: 288_000,
      fileType: "audio/mpeg",
      samples: createClickTrack({
        bpm: 72,
        durationSeconds: 12,
        sampleRate: targetSampleRate,
      }),
      sampleRate: targetSampleRate,
      sourceSampleRate,
    });

    expect(result.metadata.sampleRate).toBe(sourceSampleRate);
    expect(result.tempo.bpm).toBeGreaterThanOrEqual(70);
    expect(result.tempo.bpm).toBeLessThanOrEqual(74);
  });

  it("keeps the downbeat BPM when nearby rhythmic layers compete with double-time hits", () => {
    const sampleRate = 11025;
    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 75,
      fileSize: 6_615_000,
      fileType: "audio/wav",
      samples: createLayeredEnergyPulseTrack(sampleRate),
      sampleRate,
    });

    expect(result.tempo.bpm).toBeGreaterThanOrEqual(70);
    expect(result.tempo.bpm).toBeLessThanOrEqual(74);
    expect(result.tempo.confidencePercent).toBeGreaterThanOrEqual(50);
    expect(result.tempo.confidenceLabel).toBe("Moderate");
    const doubleTime = result.tempo.alternatives.find(
      (alternative) => alternative.label === "Double-time",
    );
    expect(doubleTime?.bpm).toBeGreaterThanOrEqual(142);
    expect(doubleTime?.bpm).toBeLessThanOrEqual(146);
  });

  it("detects a weighted minor triad as a minor key with Camelot output", () => {
    const sampleRate = 11025;
    const samples = new Float32Array(sampleRate * 6);

    addTone(samples, sampleRate, 185, 0.55); // F#3
    addTone(samples, sampleRate, 220, 0.28); // A3
    addTone(samples, sampleRate, 277.18, 0.24); // C#4

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 6,
      fileSize: 1_000_000,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.key.tonic).toBe("F#");
    expect(result.key.mode).toBe("minor");
    expect(result.key.camelot).toBe("11A");
    expect(result.key.confidencePercent).toBeGreaterThanOrEqual(50);
    expect(result.key.alternatives.length).toBeGreaterThan(0);
  });

  it("marks weak rhythmic material as low tempo confidence", () => {
    const sampleRate = 11025;
    const samples = new Float32Array(sampleRate * 5);

    addTone(samples, sampleRate, 440, 0.2);

    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 5,
      fileSize: 200_000,
      fileType: "audio/wav",
      samples,
      sampleRate,
    });

    expect(result.tempo.confidence).toBe("low");
    expect(result.notices).toContain(
      "Tempo confidence is low. Sparse, ambient, spoken, or tempo-changing audio can be hard to read.",
    );
  });

  it("maps relative keys in both directions", () => {
    expect(getRelativeKey("A", "minor")).toBe("C Major");
    expect(getRelativeKey("C", "major")).toBe("A Minor");
    expect(getRelativeKey("F#", "minor")).toBe("A Major");
  });

  it("offers half-time and double-time readings for an ambiguous tempo", () => {
    const sampleRate = 11025;
    const tempo = estimateTempoFromPcm(
      createClickTrack({ bpm: 110, durationSeconds: 24, sampleRate }),
      sampleRate,
    );

    expect(tempo.bpm).not.toBeNull();

    for (const alternative of tempo.alternatives) {
      const ratio = alternative.bpm / (tempo.bpm ?? 1);
      expect(ratio).toBeGreaterThan(0.45);
      expect(ratio).toBeLessThan(2.1);
      expect(["Half-time", "Double-time"]).toContain(alternative.label);
    }
  });

  it("reports no BPM and no key for silence instead of guessing", () => {
    const sampleRate = 11025;
    const samples = new Float32Array(sampleRate * 10);
    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 10,
      samples,
      sampleRate,
    });

    expect(result.tempo.bpm).toBeNull();
    expect(result.tempo.alternatives).toEqual([]);
    expect(result.key.tonic).toBeNull();
    expect(result.key.label).toBe("Unknown");
    expect(result.key.camelot).toBeNull();
    expect(result.notices).toHaveLength(2);
  });

  it("handles an empty buffer without throwing", () => {
    const result = analyzeAudioSamples({
      channels: 1,
      durationSeconds: 0,
      samples: new Float32Array(0),
      sampleRate: 44100,
    });

    expect(result.tempo.bpm).toBeNull();
    expect(result.tempo.confidence).toBe("low");
    expect(result.key.mode).toBeNull();
  });

  it("defaults file metadata when the caller only has PCM", () => {
    const sampleRate = 11025;
    const result = analyzeAudioSamples({
      channels: 2,
      durationSeconds: 8,
      samples: createClickTrack({ bpm: 120, durationSeconds: 8, sampleRate }),
      sampleRate,
    });

    expect(result.metadata.fileType).toBe("Unknown");
    expect(result.metadata.fileSize).toBe(0);
    expect(result.metadata.bitrateKbps).toBeNull();
    expect(result.metadata.channels).toBe(2);
    expect(result.metadata.sampleRate).toBe(sampleRate);
  });

  it("exposes the key estimator on its own", () => {
    const sampleRate = 22050;
    const samples = new Float32Array(sampleRate * 8);
    addTone(samples, sampleRate, 220, 0.3);
    addTone(samples, sampleRate, 261.63, 0.22);
    addTone(samples, sampleRate, 329.63, 0.2);

    const key = estimateKeyFromPcm(samples, sampleRate);

    expect(key.tonic).not.toBeNull();
    expect(key.camelot).toMatch(/^\d{1,2}[AB]$/);
    expect(key.label).toContain(key.tonic ?? "");
    expect(key.alternatives.length).toBeGreaterThan(0);
  });
});

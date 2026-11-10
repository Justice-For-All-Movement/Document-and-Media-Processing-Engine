#!/usr/bin/env python3
"""Local speaker segmentation (diarization) for 16 kHz mono signed 16-bit PCM.

Pipeline: energy voice-activity detection -> per-window MFCC + pitch statistics ->
agglomerative clustering with the speaker count chosen by silhouette score.
Output labels are provisional cluster names ("Speaker A", ...). They never identify a person.
Usage: diarize.py <audio.raw> [--max-speakers N] [--min-silhouette F] [--window-ms N] [--hop-ms N]
Prints one JSON document on stdout. Only numpy is required.
"""
import argparse
import json
import sys

import numpy as np

VERSION = "1.0.0"
RATE = 16000
FRAME = 400   # 25 ms
HOP = 160     # 10 ms


def frames_of(signal):
    if len(signal) < FRAME:
        return np.zeros((0, FRAME), dtype=np.float32)
    count = 1 + (len(signal) - FRAME) // HOP
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    return signal[index]


def mel_filterbank(bands=26, nfft=512, low=80.0, high=7600.0):
    mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)
    inv = lambda m: 700.0 * (10.0 ** (m / 2595.0) - 1.0)
    points = inv(np.linspace(mel(low), mel(high), bands + 2))
    bins = np.floor((nfft + 1) * points / RATE).astype(int)
    bank = np.zeros((bands, nfft // 2 + 1), dtype=np.float32)
    for i in range(1, bands + 1):
        left, centre, right = bins[i - 1], bins[i], bins[i + 1]
        for k in range(left, centre):
            bank[i - 1, k] = (k - left) / max(centre - left, 1)
        for k in range(centre, right):
            bank[i - 1, k] = (right - k) / max(right - centre, 1)
    return bank


def mfcc(frames, coefficients=13):
    emphasised = np.concatenate([frames[:, :1], frames[:, 1:] - 0.97 * frames[:, :-1]], axis=1)
    spectrum = np.abs(np.fft.rfft(emphasised * np.hamming(FRAME), 512)) ** 2
    energies = np.log(spectrum @ mel_filterbank().T + 1e-8)
    bands = energies.shape[1]
    basis = np.cos(np.pi * np.arange(coefficients)[:, None] * (2 * np.arange(bands)[None, :] + 1) / (2.0 * bands))
    return energies @ basis.T


def pitch(frames):
    """Autocorrelation pitch per frame in Hz (0 when unvoiced)."""
    out = np.zeros(len(frames), dtype=np.float32)
    lo, hi = RATE // 400, RATE // 60
    for start in range(0, len(frames), 2000):
        block = frames[start:start + 2000]
        block = block - block.mean(axis=1, keepdims=True)
        spec = np.fft.rfft(block, 1024)
        acf = np.fft.irfft(spec * np.conj(spec))[:, :hi + 1]
        zero = acf[:, 0] + 1e-9
        lag = lo + np.argmax(acf[:, lo:hi + 1], axis=1)
        strength = acf[np.arange(len(block)), lag] / zero
        out[start:start + len(block)] = np.where(strength > 0.35, RATE / lag, 0.0)
    return out


def voice_activity(frames):
    energy = 10.0 * np.log10((frames ** 2).mean(axis=1) + 1e-10)
    if len(energy) == 0:
        return np.zeros(0, dtype=bool), energy
    floor, peak = np.percentile(energy, 10), np.percentile(energy, 95)
    if peak - floor < 6.0:  # effectively constant level: either all silence or all sound
        return (energy > -50.0) & (peak > -45.0), energy
    active = energy > floor + 0.35 * (peak - floor)
    # hangover smoothing: close gaps shorter than 300 ms, drop bursts shorter than 150 ms
    def runs(mask):
        edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
        return edges[::2], edges[1::2]
    starts, ends = runs(~active)
    for s, e in zip(starts, ends):
        if e - s < 30 and s > 0 and e < len(active):
            active[s:e] = True
    starts, ends = runs(active)
    for s, e in zip(starts, ends):
        if e - s < 15:
            active[s:e] = False
    return active, energy


def linkage_labels(distance, k):
    """Average-linkage agglomerative clustering down to k clusters."""
    n = len(distance)
    clusters = {i: [i] for i in range(n)}
    d = distance.astype(np.float64).copy()
    np.fill_diagonal(d, np.inf)
    alive = np.ones(n, dtype=bool)
    sizes = np.ones(n)
    remaining = n
    while remaining > k:
        masked = np.where(alive[:, None] & alive[None, :], d, np.inf)
        a, b = np.unravel_index(np.argmin(masked), masked.shape)
        merged = (d[a] * sizes[a] + d[b] * sizes[b]) / (sizes[a] + sizes[b])
        d[a], d[:, a] = merged, merged
        d[a, a] = np.inf
        alive[b] = False
        sizes[a] += sizes[b]
        clusters[a].extend(clusters.pop(b))
        remaining -= 1
    labels = np.zeros(n, dtype=int)
    for index, members in enumerate(clusters.values()):
        labels[members] = index
    return labels


def silhouette(distance, labels):
    values = np.zeros(len(labels))
    groups = [np.flatnonzero(labels == g) for g in np.unique(labels)]
    for i in range(len(labels)):
        own = groups[[j for j, g in enumerate(groups) if i in g][0]]
        if len(own) < 2:
            continue
        a = distance[i, own].sum() / (len(own) - 1)
        b = min(distance[i, g].mean() for g in groups if g is not own)
        values[i] = (b - a) / max(a, b, 1e-9)
    return values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--max-speakers", type=int, default=6)
    parser.add_argument("--min-silhouette", type=float, default=0.25)
    parser.add_argument("--window-ms", type=int, default=1000)
    parser.add_argument("--hop-ms", type=int, default=500)
    parser.add_argument("--max-windows", type=int, default=6000)
    args = parser.parse_args()
    signal = np.fromfile(args.audio, dtype="<i2").astype(np.float32) / 32768.0
    duration_ms = int(len(signal) * 1000 / RATE)
    frames = frames_of(signal)
    active, _ = voice_activity(frames)
    result = dict(tool="diarize.py", version=VERSION, method="energy-vad+mfcc-pitch-agglomerative",
                  durationMs=duration_ms, speakers=0, turns=[], quality=dict(), provisional=True,
                  params=dict(maxSpeakers=args.max_speakers, minSilhouette=args.min_silhouette,
                              windowMs=args.window_ms, hopMs=args.hop_ms))
    if not active.any():
        result["quality"] = dict(speechMs=0, note="no speech detected")
        print(json.dumps(result))
        return
    coefficients = mfcc(frames)
    f0 = pitch(frames)
    window, hop = args.window_ms // 10, args.hop_ms // 10
    spans, features = [], []
    edges = np.flatnonzero(np.diff(np.concatenate([[0], active.astype(np.int8), [0]])))
    for start, end in zip(edges[::2], edges[1::2]):
        position = start
        while position < end:
            stop = min(position + window, end)
            if end - stop < hop // 2:
                stop = end
            if stop - position >= 30:
                chunk, voiced = coefficients[position:stop], f0[position:stop]
                voiced = voiced[voiced > 0]
                log_pitch = np.log(np.median(voiced)) if len(voiced) >= 5 else np.nan
                features.append(np.concatenate([chunk[:, 1:].mean(axis=0), chunk[:, 1:].std(axis=0), [log_pitch]]))
                spans.append((position, stop))
            if stop == end:
                break
            position += hop
    if len(spans) > args.max_windows:
        print(json.dumps(dict(error="too_many_windows")))
        sys.exit(3)
    features = np.array(features, dtype=np.float64)
    speech_ms = int(active.sum() * 10)
    if len(spans) == 0:
        result["quality"] = dict(speechMs=speech_ms, note="speech too short to segment")
        print(json.dumps(result))
        return
    pitch_column = features[:, -1]
    known = ~np.isnan(pitch_column)
    pitch_column[~known] = np.median(pitch_column[known]) if known.any() else 0.0
    scale = features.std(axis=0)
    normalised = (features - features.mean(axis=0)) / np.where(scale > 1e-9, scale, 1.0)
    normalised[:, -1] *= 4.0  # pitch is the single most speaker-specific cue available without a trained model
    distance = np.sqrt(((normalised[:, None, :] - normalised[None, :, :]) ** 2).sum(axis=2))
    labels, best_score, scores = np.zeros(len(spans), dtype=int), 0.0, {}
    for k in range(2, min(args.max_speakers, len(spans) - 1) + 1):
        candidate = linkage_labels(distance, k)
        if np.bincount(candidate).min() < 2:
            continue
        score = float(silhouette(distance, candidate).mean())
        scores[str(k)] = round(score, 4)
        if score > best_score + 0.02:
            labels, best_score = candidate, score
    if best_score < args.min_silhouette:
        labels, best_score = np.zeros(len(spans), dtype=int), 0.0
    per_window = silhouette(distance, labels) if labels.max() > 0 else np.zeros(len(spans))
    # median smoothing over three windows removes isolated flips
    smooth = labels.copy()
    for i in range(1, len(labels) - 1):
        if labels[i - 1] == labels[i + 1] != labels[i] and spans[i][0] - spans[i - 1][1] <= 0 and spans[i + 1][0] - spans[i][1] <= 0:
            smooth[i] = labels[i - 1]
    order, turns = {}, []
    for (start, end), label, sil in zip(spans, smooth, per_window):
        name = order.setdefault(int(label), len(order))
        if turns and turns[-1]["index"] == name and start * 10 - turns[-1]["endMs"] <= 400:
            turns[-1]["endMs"] = max(turns[-1]["endMs"], int(end * 10))
            turns[-1]["scores"].append(float(sil))
        else:
            if turns and start * 10 < turns[-1]["endMs"]:
                middle = (start * 10 + turns[-1]["endMs"]) // 2
                turns[-1]["endMs"] = int(middle)
                start = middle / 10
            turns.append(dict(index=name, startMs=int(start * 10), endMs=int(end * 10), scores=[float(sil)]))
    for turn in turns:
        index = turn.pop("index")
        scores_ = turn.pop("scores")
        turn["speaker"] = "Speaker " + (chr(ord("A") + index) if index < 26 else str(index + 1))
        turn["provisional"] = True
        turn["confidence"] = round(max(0.0, min(1.0, float(np.mean(scores_)))), 3) if len(order) > 1 else None
    result.update(speakers=len(order), turns=turns,
                  quality=dict(speechMs=speech_ms, windows=len(spans), silhouette=round(best_score, 4), candidates=scores,
                               note="Cluster labels are provisional; a single cluster does not prove a single speaker."))
    print(json.dumps(result))


if __name__ == "__main__":
    main()

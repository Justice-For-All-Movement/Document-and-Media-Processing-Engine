#!/usr/bin/env python3
"""Local speech recognition with PocketSphinx for 16 kHz mono signed 16-bit PCM.

Usage: asr_pocketsphinx.py <audio.raw> [--hmm DIR --lm FILE --dict FILE] [--probe]
Without model arguments the en-US model bundled with the PyPI wheel is used.
Prints one JSON document: words with start/end milliseconds and the decoder's word posterior.
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="?")
    parser.add_argument("--hmm")
    parser.add_argument("--lm")
    parser.add_argument("--dict")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--chunk-seconds", type=int, default=30)
    args = parser.parse_args()
    try:
        import pocketsphinx
        from importlib.metadata import version
        import numpy as np
    except Exception as error:  # missing engine is reported, never papered over
        print(json.dumps(dict(error="unavailable", missing="python package pocketsphinx", detail=type(error).__name__)))
        sys.exit(2)
    engine_version = version("pocketsphinx")
    model = "en-us (bundled)" if not args.hmm else "custom"
    if args.probe:
        print(json.dumps(dict(engine="pocketsphinx", version=engine_version, model=model)))
        return
    options = dict(samprate=16000)
    if args.hmm:
        options.update(hmm=args.hmm)
    if args.lm:
        options.update(lm=args.lm)
    if args.dict:
        options.update(dict=args.dict)
    decoder = pocketsphinx.Decoder(**options)
    signal = np.fromfile(args.audio, dtype="<i2")
    rate, words, position = 16000, [], 0
    limit = args.chunk_seconds * rate
    while position < len(signal):
        end = min(position + limit, len(signal))
        if end < len(signal):
            # cut at the quietest 100 ms in the last quarter of the chunk so words are not split
            tail_start = position + (limit * 3) // 4
            tail = signal[tail_start:end].astype(np.float32)
            blocks = len(tail) // 1600
            if blocks > 1:
                energy = (tail[:blocks * 1600].reshape(blocks, 1600) ** 2).mean(axis=1)
                end = tail_start + int(np.argmin(energy)) * 1600 + 800
        chunk = signal[position:end]
        decoder.start_utt()
        decoder.process_raw(chunk.tobytes(), full_utt=True)
        decoder.end_utt()
        offset_ms = position * 1000 // rate
        for segment in decoder.seg():
            word = segment.word
            if word.startswith("<") or word.startswith("["):
                continue
            if "(" in word:
                word = word[:word.index("(")]
            words.append(dict(text=word, startMs=offset_ms + segment.start_frame * 10,
                              endMs=offset_ms + (segment.end_frame + 1) * 10,
                              confidence=round(max(0.0, min(1.0, float(segment.prob))), 4)))
        position = end
    print(json.dumps(dict(engine="pocketsphinx", version=engine_version, model=model, words=words,
                          durationMs=len(signal) * 1000 // rate)))


if __name__ == "__main__":
    main()

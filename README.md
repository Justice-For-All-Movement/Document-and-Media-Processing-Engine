# Document and Media Processing Engine

Reusable country-neutral engine. Initial capabilities and limits are documented in [architecture](docs/ARCHITECTURE.md); the canonical work plan is [registry/prs.json](registry/prs.json).

```sh
npm ci
npm run check
```

All research and jurisdiction configuration belong in downstream deployments. Implementation, local tests, CI, merge and live acceptance are separate.

The opt-in `./translation` interface runs a host-supplied local translator under bounded admission and result handling; see [translation limits and runtime responsibilities](docs/TRANSLATION.md).

`./text-jobs` provides the dedicated-database [text job ledger](docs/TEXT_JOBS.md), with one-shot consumption before processor I/O and mandatory trusted authorization/outcome verification.

## Service layer

`./engine` exposes `createEngine({ sql, objects, ports, config })`: sniffed pipelines over evidence versions (PDF text with
coordinates, OCR, office/HTML/mail conversion, audio/video metadata, transcription, speaker segmentation, translation,
thumbnails, redacted working copies), revisioned corrections, full-text search anchored to pages, coordinates and
timestamps, and a per-project external-transmission policy. See [docs/ENGINE_API.md](docs/ENGINE_API.md) for the full
surface and for what is not implemented or not verified.

```sh
sudo WITH_TEST_TOOLS=1 bash scripts/install-tools.sh        # poppler, tesseract, ffmpeg, pandoc, LibreOffice, apertium, pocketsphinx …
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm run check
DATABASE_URL=… IDENTITY_PUBLIC_KEYS='{"kid":"-----BEGIN PUBLIC KEY-----…"}' \
  PROCESSING_STANDALONE_EVIDENCE=1 PROCESSING_STANDALONE_USE_DECISIONS=allow npm run serve
```

Without `TEST_DATABASE_URL` the service-layer tests are skipped visibly. Standalone evidence is a stand-in for the
evidence engine so the server can be tried alone; hosts embed `createEngine` with the real ports.

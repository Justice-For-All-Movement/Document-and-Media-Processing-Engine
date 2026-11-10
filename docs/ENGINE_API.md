# E06 Document and media processing — engine API

Service layer under the engine service convention v1. Schema `e06_processing`, capability prefix `processing`,
manifest id `E06`. Kit: `src/service-kit.ts` v1.0.1, byte-identical copy, sha256
`95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`. `src/contracts.ts` is the Identity version.

Every statement below is one of: **tested** (exercised by `tests/engine*.test.ts` against real PostgreSQL and the real
tools), **implemented, not verified** (code path exists, no real counterpart was available), or **not implemented**.

## Entry points

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes } from '@accountability/document-media-processing/engine';
import { main } from '@accountability/document-media-processing/serve';   // standalone server
createEngine({ sql, objects?, ports?: { evidence?, useDecisions?, authorization?, budget? }, config?: EngineConfig }): ProcessingEngine
```

| Dependency | Use | When absent |
|---|---|---|
| `sql` (kit `Sql`) | all state | required |
| `objects` (kit `ObjectStore`) | derivative bytes under `<tenant>/<project>/processing/<processingId>/…` | bytes are kept only through `EvidencePort.addDerivative`; with neither, derivative steps are `unavailable` |
| `ports.evidence` (`EvidencePort`) | `describe`, `getBytes`, `addDerivative` | every processing request fails `unavailable` |
| `ports.useDecisions` (`UseDecisionPort`) | `decide({subjects:[evidenceRef], action:'process', purpose})` at request time and again in every worker step; `destination: 'external:<provider>'` before any external transmission. Anything but `allow` denies | **deny** (`consent_denied`) unless `config.standalone.useDecisions === 'allow'` |
| `ports.authorization` (`AuthorizationPort`) | `authorize({capability:'processing:write', resource: evidenceRef})` at request time and in workers | skipped |
| `ports.budget` (`BudgetPort`) | reserve/commit/release around external ASR (`audio_seconds`) and external translation (`characters`) | skipped |

`EngineConfig`: `limits` (see Limits), `tempRoot`, `python`, `defaultLanguages` (ISO 639-3 or `auto`),
`languageProfiles` (function-word profiles, data), `lowConfidence` (0.6), `lowQualityMean` (0.75),
`standalone.useDecisions`, `asr.pocketsphinx` (`false` or `{python, models:{<lang>:{hmm,lm,dict}}, bundledLanguage}`),
`asr.whisper` (`{kind:'whisper.cpp'|'faster-whisper', binary, model, extraArgs?}`), `asr.providers`
(`{<id>: {baseUrl, apiKey?, model?, timeoutMs?, headers?}}`), `translation.apertium` (`false` disables),
`translation.providers` (`{<id>: {kind:'libretranslate'|'llm', baseUrl, apiKey?, model?}}`), `portContext(ctx)` (lets
the host adjust the context used for port calls made by workers), `jobLeaseMs`, `maxAttempts`.

Workers call the ports with the **requesting caller's stored context** (capabilities included). If the evidence engine
requires `evidence:read`/`evidence:write`, either the caller holds them or the host supplies `portContext`.

### Standalone server

`npm run serve` (`node src/engine/serve.ts`): runs migrations, serves HTTP, runs the job worker loop.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` (required), `PORT` (8006), `HOST` (127.0.0.1), `DATABASE_POOL_MAX`, `MAX_BODY_BYTES` | server |
| `IDENTITY_PUBLIC_KEYS` (JSON kid→PEM) or `IDENTITY_JWKS_FILE`, `IDENTITY_ISSUER` | token verification (required) |
| `OBJECT_STORE` (`fs`\|`s3`), `OBJECT_STORE_PATH`, `S3_*` | derivative bytes |
| `PROCESSING_STANDALONE_EVIDENCE=1` | enables a stand-in evidence port on the object store plus `POST /v1/standalone/evidence?filename=` (raw body). It is **not** E05: no scanning, custody, retention or encryption |
| `PROCESSING_STANDALONE_USE_DECISIONS=allow` | selects standalone mode for use decisions (otherwise processing is denied without a port) |
| `PROCESSING_CONFIG_FILE` | JSON `EngineConfig`; provider entries may carry `apiKeyEnv` naming the environment variable that holds the key |
| `PROCESSING_DEFAULT_LANGUAGES`, `PROCESSING_TEMP_DIR`, `WHISPER_BINARY` + `WHISPER_MODEL` (+ `WHISPER_KIND`), `WORKER_CONCURRENCY`, `WORKER_POLL_MS` | processing |

The standalone server has no HTTP client for a remote E05; a host embeds `createEngine` with the real port. (**not implemented**)

## Capabilities

`processing:read`, `processing:write` (request, cancel, retry, correct, translate, redact, upstream changes),
`processing:attribute_speaker` (human actors only), `processing:export`, `processing:admin` (policy, job control),
`processing:events`. `export`, `admin` and `events` are never granted by `processing:*`.

## Model

- **Processing** `E06:processing:<id>` — one record per (evidence version, options, generation). States `queued →
  running → done | partial | failed | cancelled`; flags `stale`, `blocked` with `reasons`. `partial` = the primary
  extraction succeeded but another step failed, was unavailable or was denied.
- **Step** — `metadata`, `extract`, `diarize`, `transcribe`, `thumbnails`, `translate:<lang>`; each a kit job
  (`processing.step`, dedupe key = step id; steps are unique per processing + name + tool version + params digest).
  States `queued | running | done | failed | unavailable | denied | cancelled`. A missing tool, model or language pack is
  `unavailable` with the missing thing named; a policy refusal is `denied`.
- **Representation** `E06:representation:<id>@<revision>` — kinds `text` (text layer and/or OCR, or converted text),
  `transcript`, `captions`, `translation`. Carries `language`, `languageConfidence`, `languageMethod`, `machine`,
  `engine {id, version, model, local}`, `label`, `quality`, `pages[]`, `sourceRef` (translations), `state`
  (`current|superseded`), `stale`, `blocked`, `reasons`.
- **Segment** — stable id; `kind` (`line|paragraph|utterance|cue`), `source` (`text_layer|ocr|conversion|asr|import|translation`),
  anchors `page` + `bbox [x0,y0,x1,y1]` (PDF points for PDFs, pixels for images, origin top-left), `startMs`/`endMs`
  (milliseconds from the start of the first audio stream), `anchor` (block/line, paragraph + character offsets, cue id +
  byte range), `speaker`, `sourceSegmentId`. Text is revisioned per segment: `words[] {t, b?, c?, s?, e?}` hold word
  boxes, confidences (0..1 or `null` = unknown) and timestamps.
- **Observation** — `metadata` (exiftool, ffprobe, pdfinfo, message headers; always `forgeable: true, verified: false`
  with a caveat), `quality` (per OCR page: word count, mean/min confidence, low-confidence words, languages, dpi, skew,
  orientation, script; transcription; speaker segmentation), `language`, `warning`.
- **Derivative** `E06:derivative:<id>` — `thumbnail`, `waveform`, `searchable_pdf`, `redacted_text`; bytes in the object
  store and registered through `EvidencePort.addDerivative` (`relation` = kind, idempotency key from processing id + digest).
- **Speaker turn** — provisional cluster label `Speaker A/B/…`, `provisional: true` (enforced by a CHECK constraint).
  **Speaker attribution** — separate human-reviewed mapping label → identity uref with `status: 'attributed'`,
  `verified: false`; revocable; never changes the label's `provisional: true`.

## Pipelines (chosen by sniffed content, never by declared type or filename)

| Content | Steps and tools |
|---|---|
| PDF | `metadata` (exiftool, pdfinfo) → `extract`: `pdftotext -bbox-layout` (pages, lines, word boxes); pages with no words are rasterised with `pdftoppm` and read with `tesseract` (TSV → word boxes + confidences, scaled back to PDF points); OSD picks languages when `auto`; when every page was OCRed a searchable PDF is produced (`tesseract … pdf`, `pdfunite`) → `thumbnails` (`pdftoppm`) |
| PNG/JPEG/GIF/TIFF/BMP/WebP | `metadata` → `extract`: ImageMagick re-encode with an explicit coder, OSD, tesseract; searchable PDF → `thumbnails` (`convert`) |
| docx, odt, rtf, epub, html | `extract`: `pandoc --sandbox -t plain`, one segment per paragraph with paragraph number and character offsets; `thumbnails` for office files via `soffice` → PDF → `pdftoppm` |
| doc/xls/ppt (OLE), pptx, xlsx, ods, odp | `extract`: `soffice --headless --convert-to pdf` then the PDF pipeline; coordinates refer to the rendering (`anchorSpace: 'converted_pdf'`) |
| eml | built-in MIME reader (headers, first text part or HTML part via pandoc; attachments are not opened) |
| plain text | paragraphs with character offsets |
| WebVTT | with `captionsFor: <media ref>`: literal import bound to the media version and its ffprobe duration (existing `importWebVtt`); otherwise read as text |
| audio/video (wav, mp3, flac, ogg, mp4/m4a/mov, mkv/webm, avi) | `metadata` (exiftool, ffprobe) → `diarize` (ffmpeg → 16 kHz PCM → `tools/diarize.py`) → `transcribe` (ffmpeg → ASR adapter; utterances split on speaker change, 700 ms gaps or 40 words) → `thumbnails` (ffmpeg poster frame, waveform image) |
| anything else | `failed` with `unsupported_media_type` |

Optional `translateTo: [..]` appends `translate:<lang>` steps. `steps: [..]` restricts the base steps.

### Adapters

| Adapter | Status |
|---|---|
| ASR `pocketsphinx` (PyPI wheel 5.1.1, bundled en-US model; other languages need `models` paths) | **tested** on espeak-ng speech: real word timestamps and decoder scores; accuracy is low (small-vocabulary statistical recogniser) |
| ASR `whisper.cpp` / `faster-whisper` command adapter (preferred automatically when binary + model are configured) | **implemented, not verified** against a real model (model downloads were blocked); invocation and JSON parsing are tested with a fake binary |
| ASR external, OpenAI-compatible `POST {baseUrl}/audio/transcriptions` (multipart, `verbose_json`, word timestamps) | **implemented, not verified against a live provider**; tested against a local test server |
| Speaker segmentation `tools/diarize.py` (energy VAD, MFCC + pitch statistics, average-linkage clustering, speaker count by silhouette) | **tested**: separates two synthesised voices; not evaluated on real recordings, overlapping speech is not modelled |
| Translation `apertium` (rule-based, installed pairs from `apertium -l`) | **tested** for `eng-spa` |
| Translation external LibreTranslate-compatible `POST {baseUrl}/translate` | **implemented, not verified against a live provider**; tested against a local test server |
| Translation external chat-completions (`POST {baseUrl}/chat/completions`, JSON-array contract) | **implemented, not verified against a live provider**; tested against a local test server, including a non-conforming reply (`provider_invalid_response`) |

Selection: a local engine is used by default. An external provider is used **only** when the request names it
(`asrProvider`, `translationProvider`, `provider`) and policy allows it. Provider URLs and keys come from deployment
configuration; requests carry a provider id only. Keys are never stored, logged, audited or returned.

## Policy

Per project: `{ externalTransmission: 'forbidden' | 'allowed', allowedProviders: string[], languages: string[] }`;
default `forbidden`. Before any external call the engine checks policy (and the use-decision port with
`destination: 'external:<id>'`), audits `processing.policy_denied` or `processing.external_transmission_allowed`, and
refuses with `policy_denied` (HTTP 403; in a pipeline the step becomes `denied`). **tested**

## Service methods (`ctx: ServiceContext` first; capability in brackets)

```ts
getPolicy(ctx): Promise<ProcessingPolicy>                                                             // [read]
setPolicy(ctx, { externalTransmission, allowedProviders?, languages?, idempotencyKey? }): Promise<ProcessingPolicy> // [admin]
describeTools(ctx): Promise<{ tools: Record<string,string|null>; ocrLanguages: string[]; asr: Availability[]; translation: Availability[]; diarization: Availability }> // [read]
requestProcessing(ctx, { evidenceRef, languages?, steps?, translateTo?, asrProvider?, translationProvider?, captionsFor?, force?, idempotencyKey? }): Promise<ProcessingView> // [write]
getProcessing(ctx, id): Promise<ProcessingView>                                                       // [read]
listProcessing(ctx, { evidenceRef?, state?, limit? }?): Promise<ProcessingView[]>                     // [read]
cancelProcessing(ctx, id, { reason? }?): Promise<ProcessingView>                                      // [write]
retryProcessing(ctx, id): Promise<ProcessingView>                                                     // [write] failed|partial|cancelled only
getAlignment(ctx, processingId): Promise<{ processing; representations: RepresentationView[]; speakers }> // [read]
getRepresentation(ctx, ref /* id or E06:representation:<id>[@rev] */, { revision? }?): Promise<RepresentationView> // [read]
listRevisions(ctx, ref): Promise<{ ref; revision; at; actorId; actorKind; reason; segmentIds; textSha256 }[]> // [read]
locate(ctx, ref, { page, x, y } | { ms }): Promise<{ representationRef; evidenceRef; segment: SegmentView; word: Word | null } | null> // [read]
correctText(ctx, { representation, corrections: { segmentId, text }[], reason, expectedRevision?, idempotencyKey? }): Promise<{ representationRef; previousRef; revision; segmentIds; staled: string[] }> // [write]
requestTranslation(ctx, { representation, targetLanguage, provider?, idempotencyKey? }): Promise<{ processingId; stepId; jobId }> // [write]
listObservations(ctx, processingId, { kind? }?): Promise<ObservationView[]>                           // [read]
listSpeakers(ctx, processingId): Promise<{ turns: { label; startMs; endMs; confidence; provisional: true }[]; labels: SpeakerView[] }> // [read]
attributeSpeaker(ctx, { processingId, label, identityRef, basis, idempotencyKey? }): Promise<SpeakerView> // [attribute_speaker, human]
revokeSpeakerAttribution(ctx, { attributionId, reason }): Promise<{ id; status: 'revoked' }>          // [attribute_speaker, human]
createRedactedDerivative(ctx, { representation, redactions: RedactionSelector[], idempotencyKey? }): Promise<DerivativeView> // [write]
listDerivatives(ctx, processingId): Promise<DerivativeView[]>                                         // [read]
getDerivativeBytes(ctx, id): Promise<{ derivative: DerivativeView; bytes: Uint8Array }>               // [read]
exportSearchable(ctx, { representation, format: 'txt'|'json'|'vtt', revision? }): Promise<{ mediaType; filename; bytes; representationRef }> // [export]
searchSegments(ctx, { q, limit?, evidenceRef?, language?, kinds? }): Promise<SegmentHit[]>            // [read]
listJobs(ctx, { states?, limit? }?): Promise<Job[]>   controlJob(ctx, id, 'cancel'|'pause'|'resume'|'retry'): Promise<Job> // [admin]
runJobs({ worker?, limit?, leaseMs? }?): Promise<number>   // one worker pass; not caller-scoped
// StandardEngine
inspect(ctx, ref) [read] · search(ctx, { q, limit? }) [read] · audit(ctx, opts?) [read] · events(ctx, opts?) [events]
applyUpstreamChange(ctx, change) [write] · health()
```

Behaviour worth knowing:

- **requestProcessing** is idempotent per (evidence version, options): the same request returns the existing record;
  `force: true` starts a new generation and, when it finishes, marks the earlier generation's representations
  `superseded` + stale (`processing.stale`). Evidence that is not yet `available` is accepted; the plan job retries with
  backoff (6 attempts) and then fails. Bytes are re-read and their sha256 compared to the recorded digest in every step.
- **correctText** (human or agent; actor and reason recorded) writes revision N+1: prior segment text rows are kept and
  addressable (`@<rev>`), segment ids never change, word boxes/timestamps are kept when the word count is unchanged
  (corrected words get `c: null`). It marks translations of that representation and derivatives pinned to older
  revisions stale, and emits `processing.text_corrected` (and `translation.revised` for a translation).
- **Redaction selectors**: `{segmentId, start?, end?}` (UTF-16 offsets in the segment text at the pinned revision),
  `{page, bbox}` (words intersecting the region; whole segment when word boxes are gone), `{startMs, endMs}`. Output is
  a JSON working copy with `[REDACTED]` markers; positions of redacted segments are withheld; the original and the
  representation are untouched. Pixel-level redaction of page images or audio is **not implemented**.
- **search / searchSegments**: PostgreSQL full-text (`simple` configuration, `websearch_to_tsquery`) over the current
  revision of every segment. Hits carry `representationRef` (with revision), `evidenceRef`, `segmentId`, `page`, `bbox`,
  `unit`, `startMs`, `endMs`, `speaker`, `stale`, `corrected`, `machineTranslation`. Blocked and superseded
  representations are excluded. No stemming or language-specific analysis.
- **Blocked** objects stay visible in `inspect` (state `blocked`, reasons) but their content cannot be read
  (`consent_denied`).

## Events (outbox; `subject` is a uref)

| Type | Subject | Payload |
|---|---|---|
| `processing.requested` | processing | `evidenceRef, generation, cause?` |
| `processing.completed` / `processing.failed` | processing | `evidenceRef, state, representations[], steps{}, failure?` |
| `processing.low_quality` | representation@1 (or processing) | `evidenceRef, step, reasons[]` |
| `processing.text_corrected` | representation@new | `evidenceRef, representationRef, previousRef, revision, previousRevision, segmentIds[], kind, actorKind, stale[]` |
| `translation.completed` | representation@1 | `evidenceRef, sourceRef, language, machineTranslation, engine` |
| `translation.revised` | representation@new | same as `text_corrected` |
| `processing.stale` / `processing.blocked` | processing, representation or derivative | `reason, cause` |
| `processing.cancelled`, `processing.redacted`, `processing.speaker_attributed`, `processing.policy_changed` | processing / derivative / processing / `E06:policy:project` | ids only |

## applyUpstreamChange

Idempotent per (tenant, project, `eventId`); returns the affected urefs. Matching is by evidence id against each
processing record's `sources` (`E05:evidence_version:<id>@<rev>` and `E05:evidence:<id>`), and by representation sources
(e.g. the media version a caption import was bound to).

- `source_superseded`, `source_corrected` (and other non-permission kinds): records for the same or an older revision
  are marked stale with the reason (`processing.stale` per object); nothing is deleted or rewritten. For
  superseded/corrected the engine then asks the evidence port for the newer version (the newer pinned ref in
  `refs`, else the unpinned ref) and enqueues processing of it with the same options. A ref pinned to an older revision
  than a record leaves that record untouched.
- `permission_withdrawn`, `source_removed`, `rights_changed`: the refs are recorded as blocks; matching processing
  records, representations and derivatives become `blocked` (`processing.blocked`), queued or running jobs are
  cancelled, and later requests for that evidence are refused with `consent_denied`.
- `permission_changed`: the gate is re-evaluated; a denial blocks as above, otherwise nothing changes.

## HTTP routes

Standard: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`,
`GET /v1/events`, `POST /v1/upstream-changes`. Own (JSON; `Idempotency-Key` header honoured on mutating routes):

| Route | Method |
|---|---|
| `GET|PUT /v1/policy` · `GET /v1/tools` | `getPolicy` / `setPolicy` · `describeTools` |
| `POST /v1/processing/jobs` (202) · `GET /v1/processing` · `GET /v1/processing/:id` | `requestProcessing` · `listProcessing` · `getProcessing` |
| `POST /v1/processing/:id/cancel` · `POST /v1/processing/:id/retry` | `cancelProcessing` · `retryProcessing` |
| `GET /v1/processing/:id/alignment` · `/observations` · `/speakers` · `/derivatives` | `getAlignment` · `listObservations` · `listSpeakers` · `listDerivatives` |
| `POST /v1/processing/:id/speaker-attributions` · `POST /v1/speaker-attributions/:id/revoke` | `attributeSpeaker` · `revokeSpeakerAttribution` |
| `GET /v1/representations/:id[?revision=]` · `GET /v1/representations/:id/revisions` | `getRepresentation` · `listRevisions` |
| `POST /v1/representations/:id/revisions` and `POST /v1/transcripts/:id/revisions` (201) | `correctText` |
| `POST /v1/representations/:id/translations` (202) · `POST /v1/representations/:id/redactions` (201) | `requestTranslation` · `createRedactedDerivative` |
| `GET /v1/representations/:id/locate?page=&x=&y=` or `?ms=` · `GET /v1/representations/:id/export?format=` | `locate` · `exportSearchable` |
| `GET /v1/derivatives/:id/bytes` · `GET /v1/segments/search?q=` | `getDerivativeBytes` · `searchSegments` |
| `GET /v1/jobs` · `POST /v1/jobs/:id/:action` | `listJobs` · `controlJob` |

`policy_denied` is answered 403 and `integrity_failure` 409 by a wrapper in `routes()` because the kit's status table does
not list those codes.

## Subprocess safety and limits

Every tool runs through `ToolRunner`: resolved on a fixed path (`/usr/local/bin:/usr/bin:/bin`), argument arrays, no
shell, its own process group killed on timeout or cancellation, a private working directory that is always removed, a
minimal environment (parent environment not inherited; `HOME`/`TMPDIR` = working directory; HTTP proxies pointed at a
dead local port), output caps, and `prlimit` file-size and address-space limits when `prlimit` exists (the address-space
limit is not applied to LibreOffice, pandoc, ffmpeg and Python, which reserve large virtual ranges). Input files are
named by the engine from the sniffed type, never from the uploaded filename. pandoc runs with `--sandbox`; ffmpeg and
ffprobe with `-protocol_whitelist file,pipe`; ImageMagick only with an explicit coder for sniffed raster types (SVG,
playlists and scripts are text and never reach a decoder).

Defaults (`config.limits`): `timeoutMs` 180 s per tool call, `maxStdoutBytes` 64 MiB, `memoryBytes` 6 GiB,
`maxFileBytes` 2 GiB, `maxInputBytes` 1 GiB, `maxPages` 2000, `maxOcrPages` 300, `maxMediaSeconds` 4 h, `maxSegments`
400 000, `ocrDpi` 200, `thumbnailPages` 3.

This is process-level containment, not a security sandbox: there is no seccomp, namespace or user isolation. The
container definitions under `containers/` (`pdf-text`, `pdf-ocr`) and `src/docker-*.ts` remain available as a stricter
isolation mode for PDFs but are **not wired into the service layer** (Docker was unavailable in the build environment).
LibreOffice is the least constrained converter; route untrusted office files through a container or VM in
high-risk deployments.

## System packages and tools (`scripts/install-tools.sh`)

apt: `poppler-utils` (pdftotext, pdftoppm, pdfinfo, pdfunite), `tesseract-ocr`, `tesseract-ocr-osd`,
`tesseract-ocr-eng|spa|ukr` (language packs are deployment configuration), `imagemagick`, `ffmpeg`,
`libimage-exiftool-perl`, `pandoc`, `libreoffice-writer|calc|impress|draw`, `apertium`, `apertium-eng-spa` (pairs are
deployment configuration), `python3`, `python3-numpy`, `python3-pip`, `util-linux` (prlimit), `fonts-dejavu-core`.
PyPI: `pocketsphinx==5.1.1`. Tests additionally use `espeak-ng` and `sox` to synthesise fixtures.

Versions used for the recorded test run: poppler 24.02.0, tesseract 5.3.4, ffmpeg 6.1.1, exiftool 12.76, pandoc 3.1.3,
LibreOffice 24.2, apertium 3.9.4 (apertium-eng-spa 0.8.1), pocketsphinx 5.1.1.

## Not implemented / not verified

- No live external provider was contacted; external ASR and both translation adapters are verified only against a local
  test server. The whisper command adapter was never run with a real model.
- Local ASR covers the language(s) with a configured PocketSphinx model (bundled: en-US). Other languages yield
  `unavailable` unless Whisper or a provider is configured. Recognition quality on real recordings was not measured.
- Local translation covers installed Apertium pairs only (here `eng-spa`/`spa-eng`).
- Language identification is a function-word profile match among configured languages (8 built-in profiles); it reports
  `null` when unsure. It is not a general language detector. OCR `auto` uses tesseract OSD script detection.
- Diarization has no overlap handling, no speaker embeddings from a trained model and was not evaluated on real speech.
- No GPU workers, no image/audio/video redaction, no table or form structure extraction, no handwriting model, no
  "structured extraction proposals" beyond segments, words and observations.
- Password-protected PDFs fail with a clear error; attachments inside e-mail are not opened.
- Container isolation is not wired into the service layer (see above). No independent security review.
- The earlier foundation modules (`text-jobs`, `text-outputs`, reconciliation HTTP, `translation`, Docker runtimes) are
  kept with their tests but the service layer does not use them, except `captions.ts` (`importWebVtt`).
- Not deployed to a hosted environment.

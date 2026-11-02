# Processing boundary

The initial text processor requires a trusted source reference, exact bytes/hash, clean scan result and authorized processing purpose. It creates a text derivative with source edition, source hash, processor version and retrieval timestamp. Strict UTF8 rejects malformed bytes and NUL content. Media transcript validation checks interval ordering, duration and confidence bounds. Versioned adapter job keys bind source revision, bytes, operation and configuration.

UTF8 text extraction, transcript structure/job validation and an opt-in isolated Docker PDF embedded-text adapter are implemented. See [PDF runtime](PDF_RUNTIME.md) for the fixed isolation profile, trust boundary, CI qualification and operational limits. The opt-in OCR/page geometry adapter is described in OCR_RUNTIME.md; speech recognition, qualified translation runtimes, durable dispatch and live model calls remain separate planned integrations. The source record's quarantine and processing authorization must come from a trusted gateway, not user-provided form fields. Protected or sealed content is not automatically available to processors.

## Timed captions

The opt-in caption importer is documented in CAPTIONS.md. It preserves supplied transcript timing, exact caption/media edition bindings and original source byte ranges, retaining payload as literal untrusted text. Speech recognition and deployed translation models remain pending capabilities.

## Local translation execution

[Local text translation](TRANSLATION.md) adds a fixed-manifest callback adapter with exact source/decoded-text/model/purpose provenance, finite budgets and cancellation. It provides no bundled or isolated model; the host must separately verify those runtime properties. Linguistic accuracy, recognition, worker integration and live acceptance remain pending.

## Durable text job orchestration

[Text jobs](TEXT_JOBS.md) add dedicated-database submission, purpose/actor-bound leases, one-shot consumption, fresh clock checks, conservative consumed uncertainty and verified private outcome references. A production dispatch daemon, source/object service integration, OCR/model orchestration, quality/cost qualification and live acceptance remain pending. Specific network-session ledger scenarios are qualified by the disposable CI fixture below.

Text jobs also expose opt-in verified terminal no-output settlement. Processor errors and lease expiry alone remain uncertain. The optional verifier must establish stopped execution and no possible late derivative; settlement atomically records a failure receipt without issuing a retry permit.

## Network database concurrency verification

[PostgreSQL contention tests](POSTGRES_TESTS.md) qualify specific ledger invariants using separate restricted TCP sessions on a disposable CI PostgreSQL 17 service, including a directly observed lock wait. These tests are distinct from embedded PGlite evidence and do not qualify deployment TLS, failover, production throughput or source/receipt services.

Explicit manager-only retry lineage can queue one deterministic successor of an exact verified failed edition after fresh stopped/no-output verification. Failed parents stay immutable, children preserve exact input/profile/purpose, and each needs fresh lease/start authorization/consumption. Retry never clears unresolved consumption; a sixteen-generation cap bounds each lineage. Real receipt and liveness services remain unqualified.

## Single-job worker integration

[Text worker](TEXT_WORKER.md) joins the accepted ledger and UTF8 processor through host source/private-storage callbacks, consuming before I/O and preserving uncertainty after errors/timeouts. It is not a daemon or qualified object/proof service; downstream gateways must enforce current policy and verify persisted private bytes independently.

## Authenticated Evidence source integration

[Evidence text source](EVIDENCE_SOURCE.md) connects the single-job worker to the accepted Evidence facade through a separately pinned service SDK contract, keeping each engine database separate. It repeats current processing-policy checks, authenticates Evidence calls and checks exact clean plaintext metadata and verified bytes before/after reading. Neither post-read checks nor a consumed snapshot are distributed permission fencing. Private output storage/receipt and deployment qualification remain separate.

## Private output receipts

[Private text outputs](TEXT_OUTPUTS.md) persist encrypted text in a Processing-owned object root and exact immutable metadata/receipt records in its own operational database. Durable pre-write intents retain incomplete blob/SQL work. Verification independently rereads the source and persisted output; Explicit manager finalization independently verifies already-existing pending bytes/source and publishes one exact receipt without rerunning a processor or rewriting objects. SQL/blob atomicity, cleanup, no-output/liveness services and deployment acceptance remain separate.

All text-ledger verification callbacks enforce monotonic admission/result deadlines and close their signals on every exit. Cached responses still require timely current verification. This fences late callback results before ledger transitions; it does not preempt JavaScript or atomically fence remote policy changes. See TEXT_JOBS.md.

## Controlled host reconciliation

[Text-output reconciliation](TEXT_RECONCILIATION.md) connects explicit manager-selected committed-output recovery or existing-byte finalization to independently verified job completion. Exact execution bindings and fresh current proof gate acknowledgements, while errors preserve uncertainty without automatic execution or retry. Authentication/HTTP hosting, safe cleanup, stopped/liveness services and deployment acceptance remain separate.

No-output settlement/retry now check exact known Processing output intent/artifact/receipt presence under the shared project lock before cached lookup. Intent admission and settlement serialize conservatively; any known record denies. Independent quiescence/no-output proof remains mandatory, and absence never becomes proof. No cleanup or deployed liveness service is introduced.

## Private reconciliation HTTP admission

[Reconciliation HTTP](RECONCILIATION_HTTP.md) adds an opt-in native Fetch adapter with only session and explicit existing-output reconciliation. Bounded body capture precedes fresh trusted host human-manager authentication, then fixed origin/scope/purpose/list/CSRF checks gate the accepted coordinator. Begun SQL/FS remains awaited and uncertainty never authorizes execution. Actual login/listening server/TLS/proxy/UI and deployed policy/key/source/storage acceptance remain separate.

## Current Identity membership composition

[Identity reconciliation HTTP](IDENTITY_RECONCILIATION_HTTP.md) composes pinned current stored human-owner membership with the accepted private Processing HTTP/coordinator flow, keeping separate owning operational databases. Current Identity authority supplements the Processing manager/purpose/CSRF/domain checks. These are sequential service snapshots, not atomic revocation/action fencing; real session/listening host/deployment qualification remain pending.

## Direct TLS transport bridge

[Node reconciliation listener](NODE_RECONCILIATION_LISTENER.md) adapts direct HTTPS HTTP/1.1 requests to the accepted Fetch handler with exact authority, private bounded streams, cancellation and conservative unknown outcomes. The host supplies and limits its HTTPS server/certificates/session service. Loopback TLS tests are distinct from production login/TLS/proxy/browser acceptance and database-network qualification.

## Exact UTF8 admission snapshot

The direct UTF8 API requires a literal boolean processing grant. It detaches context and validates a detached exact source reference before tenant/project admission. Caller-owned bytes and source digest are read once; a bounded independent byte snapshot is used for both integrity verification and strict decoding. Returned provenance uses only the admitted reference and verified digest, preventing caller property re-reads from changing the source edition after admission. These local checks do not authenticate a caller-supplied clean/permission assertion; a trusted current-policy gateway remains mandatory.


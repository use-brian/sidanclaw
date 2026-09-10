# Durable intake backend reference

This reference accepts submissions into a private local queue, then forwards
them to Brian with stable idempotency keys. It is executable integration
evidence and a starting point for a site's backend. It does not replace Brian's
CRM, verify a visitor's identity, or qualify a production website.

## Prerequisites and configuration

Use Node 22.13 or later on the supported Node 22 line. Its built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) is unflagged from 22.13,
but remains experimental on that line. The queue uses no extra npm package.

Use owner-private local storage, not a network filesystem. All processes for
one upstream rate-limit lane must use the same file. Separate files do not
coordinate pacing. The parent directory and its ancestors must be controlled
by the operator; the queue refuses an existing public, foreign-owned or
symlinked database file. Include the queue, WAL and backups in the backend's
privacy and recovery inventory. Clearing a receipt payload is a logical
deletion, not a claim that old storage blocks or backups have been destroyed.

Before starting, an owner must configure the intake definitions and approve
Brian's intake replay policy. Choose an explicit queue retry horizon no longer
than that approved period. The queue does not infer a period or approve policy.
The API origin, workspace, stable source, horizon and rate-limit configuration
are bound to the file; reopening it with a different configuration is refused.
The workspace/source options identify the local queue. Brian derives remote
workspace and replay authority from the intake key, so validate the credential
and definition against the intended destination during operator qualification.

Supply an intake credential and a separate private backend bearer token through
the named environment variables using your secret manager. The backend token
needs at least 32 non-whitespace characters. Never put either token in a
browser, command argument, checked-in file or report. No `.env` is loaded.

From the OSS repository root, inspect the CLI without a network request:

```sh
node scripts/crm/reference-intake-backend.mjs --help
```

An operator invocation uses explicit, operator-chosen values:

```sh
node scripts/crm/reference-intake-backend.mjs \
  --db "$BRIAN_QUEUE_DATABASE" \
  --api-url "$BRIAN_API_ORIGIN" \
  --workspace "$BRIAN_WORKSPACE_ID" \
  --source website_backend \
  --replay-horizon-seconds "$BRIAN_APPROVED_REPLAY_SECONDS"
```

The default credential variables are `BRIAN_INTAKE_TOKEN` and
`BRIAN_QUEUE_TOKEN`. `--intake-token-env` and `--backend-token-env` select
different variable names. Output reports the loopback URL and configured
source/workspace only. It binds to `127.0.0.1` on an ephemeral port by default;
`--port` chooses another loopback port. SIGINT/SIGTERM stops the fixture and
closes the database. Fatal worker errors stop accepting new work and exit
nonzero. Restart with the same configuration and file to recover pending work.

## Backend HTTP contract

Every route requires `Authorization: Bearer <private backend token>`. This
credential can inspect and cancel queued payloads. Keep the service behind
your trusted backend boundary; it is not a visitor authentication mechanism.

| Request | Result |
| --- | --- |
| `POST /submissions/<definitionKey>` | Accept `{idempotencyKey, body: {fields, ...}}`; return `{receipt}` only after the queue commit. Queued/leased state is HTTP 202; an already terminal/failed receipt is HTTP 200 and retains its state. |
| `GET /receipts/<id>` | Read state, timestamps, attempts, uncertainty, fixed error category and validated Brian result. No payload by default. |
| `GET /receipts/<id>?includePayload=true` | Explicit private owner inspection; successful, retired and cancelled payloads are null. |
| `POST /receipts/<id>/retry` | Require `{confirmed:true}`. Retry a permanent failure only within its original horizon, preserving the same key and body. |
| `POST /receipts/<id>/cancel` | Require `{confirmed:true}`. Remove the local payload and prevent another lease; this is not Brian erasure or proof that an in-flight send never arrived. |

The body may contain `fields`, `externalIdentity`, `submittedAt` and
`identityProof` according to the configured Brian definition. It is frozen on
enqueue. An exact repeated enqueue returns the same receipt; changed reuse is
HTTP 409. Retrying a lost acknowledgement with the same key recovers its id.
A 202 means durably queued, not accepted by Brian. Persist the receipt/key and
show the current state honestly to visitors.

The fixture uses the direct peer address for its per-visitor limit and ignores
forwarded-IP headers. Calls from one loopback peer share that limit. A real
site should use `DurableIntakeQueue` with a trusted session/network-derived
`visitorId`; accepting a browser-supplied identifier would bypass the limit.
The backend must generate required address/subject proofs and cannot replace
them with a caller's `verified` flag. An expired proof may cause a permanent
rejection; silently changing a frozen request is not a safe retry.

## Delivery and recovery states

Workers share transactional leases and aggregate claim pacing, with a default
1100 ms spacing, bounded request timeout and exponential retry delay. They
respect `Retry-After` for 408, 425, 429 and 5xx; transport uncertainty retries
with the same key. Other 4xx are permanent until owner review. Intake tokens
are obtained at dispatch and never persisted. Rotating to another token must
preserve Brian's authorized source/replay scope; the CLI reads its process
environment, so a secret-store change requires a controlled restart or an
embedding callback that reads that store.

| State | Meaning and owner action |
| --- | --- |
| `queued` / `leased` | Pending or in flight. Retain the same key and body. |
| `delivered` | Brian returned a validated new or duplicate result. The local payload is cleared. |
| `retired` | Brian recognizes an erased/retained submission's redacted terminal receipt. Do not recreate it. |
| `failed` | Inspect the fixed category/status and private payload; resolve credentials or configuration before an explicit retry. |
| `paused` | The approved retry horizon expired or the next retry would exceed it. Inspect Brian and policy; automatic retry or a newly minted key could duplicate old work. |
| `cancelled` | Local dispatch stopped and payload cleared. If `uncertain` is true, inspect Brian before claiming the request did not commit. |

An old worker cannot overwrite cancellation or a newer completed lease.
Process death after remote commit can still leave the local outcome uncertain;
replay resolves that uncertainty only while Brian retains the matching receipt.
Queue storage failure is not a queued acknowledgement. Monitor process failure,
disk capacity and nonterminal receipt age in the real deployment. A restart
alone does not resolve expired replay policy or a permanent rejection.

## Local evidence and owed integration work

```sh
pnpm --filter @use-brian/api exec vitest run \
  src/crm-operations/__tests__/reference-intake.test.ts
```

The suite uses temporary SQLite files, fake time and loopback fake upstreams.
It proves shared-process pacing, actual worker death after remote acceptance,
restart/replay, stale leases, failure/cancellation, secret minimization and
500 submissions over a simulated hour. That is not a measured live load test,
two-hour operational outage, upstream contract qualification or recovery drill.
Production ingress, identity proofs, secret custody, horizon approval, queue
privacy/backup policy, deployment monitoring and real provider/site acceptance
remain owner work in the full CRM assurance programme.

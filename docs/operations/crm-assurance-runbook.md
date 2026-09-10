# CRM assurance qualification

Engineering acceptance and operational readiness are separate decisions. This
runbook qualifies a release and its configuration; it is not a production
cutover approval or a second contact ledger. Use fictional identities and
reserved domains in published fixtures, reports, issues and commit metadata.

## Local engineering evidence

Use Node 22.13 or later in the Node 22 line, installed workspace dependencies,
and PostgreSQL 18 with pgvector and pg_trgm. The launcher builds shared/core,
runs the actual migrations, creates separate owner/application database roles,
and runs the versioned suite allowlist. The API route suites use loopback
Express servers with real canonical stores. Models, provider HTTP/SMTP and
channel delivery are fake; no provider credentials or ambient `.env` are used.

From the OSS root:

```sh
node scripts/crm/brian-contract-check.mjs --help
node scripts/crm/brian-contract-check.mjs --mode local \
  --pg-bin /path/to/postgresql18/bin --report-dir /tmp/assurance-release-oss
```

For a platform checkout, repeat with a **new** report directory and the explicit
hosted overlay:

```sh
node scripts/crm/brian-contract-check.mjs --mode local \
  --pg-bin /path/to/postgresql18/bin \
  --migration-dir /path/to/brian-platform/packages/api-platform/migrations \
  --report-dir /tmp/assurance-release-hosted
```

No existing report directory is overwritten. The fixture ignores ambient local
database URLs and refuses nonlocal ones. Never replace this command with the
broad integration configuration against a development or production database.
Disposal stops/removes only the owned cluster. Missing PostgreSQL/extensions,
an unsuccessful migration or a failed cleanup is visible evidence, not a mock
pass. A test group has a 15-minute deadline; do not repeatedly rerun unchanged
failures. Read the failing assertion, fix its cause within scope, then repeat
the affected evidence.

`report.json` is authoritative; `report.md` is its readable matrix. The report
contains the exact OSS/platform commit SHA and dirty-state fingerprints, suite
source hashes, fixture manifest hash, actual migration names and file hashes,
schema hash, PostgreSQL/extension versions, timestamps, assertion names and
private evidence paths. `logical-restore.json` and `physical-restore.json`
carry actual backup-manifest hashes and restored application/integrity proofs.
The manifest is `scripts/crm/fixtures/association-assurance.json`; it enumerates
every suite, its matrix rows and the operator gates. Empty, skipped, missing,
failed or interrupted suites cannot pass. Review dirty-state evidence before
claiming a report qualifies an immutable published release.

Exit 0 means all local engineering rows passed. Any incomplete engineering
report exits nonzero. Row states are `passed`, `failed`, `blocked` and `not_run`.
Operational readiness stays `not_run` until the owners below supply evidence.
Unit tests do not count as real transaction, RLS or restore evidence. Simulated
500-submission/burst/outage tests do not measure production latency.

## Remote qualification boundaries

Remote modes perform **catalog qualification only**. They never dispatch the
local destructive suite remotely. Use an owner-private token file (mode 0600)
or name an explicit environment variable with `--token-env`; never place a
credential value in argv, a report or a ticket. Only CRM integration credentials
are accepted, and catalog discovery must match the requested workspace.

```sh
node scripts/crm/brian-contract-check.mjs --mode remote-qa \
  --api-url https://api.example.com --workspace-id WORKSPACE_UUID \
  --token-file /private/qa-crm-token --dedicated-workspace \
  --identity-prefix assurance-release --confirm \
  --report-dir /tmp/assurance-release-qa-preflight
```

Confirm only after the operator has verified the dedicated QA workspace,
controlled identity namespace, selected release/schema and credential grants.
The explicit confirmation permits the qualification read; it does not create
people, send email or execute destructive exercises. Those live tests require
the owner-reviewed procedures below. Production mode omits the dedicated/prefix/
confirmation flags and permits only the same catalog read. Neither remote mode
has an erase/import/send/load/rate-limit-probe dispatch path. Both retain
`not_run` engineering cases and return nonzero for incomplete acceptance even
when catalog qualification succeeds.

## Compatibility review

- Match the application SHA to the actual migration/schema inventory in the
  report. Standalone OSS and hosted overlays must both pass before qualifying
  both editions. Run each repository's documented unit/type/smoke checks and
  the platform checker; compare failures with the recorded pre-edit baseline.
- Existing workspace migration backfill preserves Association API access;
  newly created workspaces start disabled. Workspace enablement, Home placement
  and assistant read/write grants are independent. No workspace-specific DDL
  is performed on enable. Draining/disabled states retain history and committed
  replay/recovery paths.
- Existing member and legacy API contracts remain available. `sk_crm_` is a
  separate scoped integration family; intake keys are not general CRM keys.
  A credential never grants mailbox access by itself. Versioned catalogs,
  immutable request identities and explicit provider reconciliation govern
  retries; ambiguous provider acceptance is never proof of external exactly-once
  delivery. Privacy v1 remains supported alongside `crm-privacy-v2`.
- Migration 522 begins protected erasure-journal coverage. Earlier deletions
  cannot be reconstructed from later journal capture. Qualify this boundary,
  encryption-key custody, checkpoint freshness and the 64 MiB v1 journal bound
  before adopting a backup. Follow [recovery](crm-recovery.md), including
  erasure replay before application checks and before any managed sender starts.
- Rebuild compiled packages after source changes. Reverting code cannot undo a
  forward-only database migration. Take an encrypted pre-upgrade snapshot,
  rehearse on staging, and recover a matched code/database pair when necessary.

## Owner evidence before sole-record cutover

No owner names, dates or sign-offs are inferred. Fill these fields only after
the corresponding exercise is actually completed.

| Gate | Required evidence | Accountable owner | Date | Evidence/location | Result |
| --- | --- | --- | --- | --- | --- |
| Integration | Website identity proof; durable intake; verified PSP signatures/object mapping; replay and missed-event reconciliation; two-hour outage; source pacing; connector grants; actual sent-folder and timeline evidence | Unassigned | Pending | Pending | not_run |
| Data | Approved manifest and reconciled source/import counts; explained rejected rows; QA rehearsal; write freeze/final delta/cutoff; source retention | Unassigned | Pending | Pending | not_run |
| Privacy | Approved purposes, localized wording, retention cutoffs, legal holds and tombstone policy; subject export and erase exercise; external campaign withdrawal propagation | Unassigned | Pending | Pending | not_run |
| Deployment | Pinned release/schema; separate DB roles; encrypted off-instance backup/WAL and key custody; monitoring; measured restore RPO/RTO with journal replay; staging rehearsal; rollback decision | Unassigned | Pending | Pending | not_run |
| Staff | Unassisted lookup, lead advancement, complimentary membership, consented attendee export, order/reconciliation handling and digest follow-up; record time and blockers | Unassigned | Pending | Pending | not_run |
| Measured soak | 500 synthetic submissions over one hour; selected p95 target (initially under two seconds), queue lag and 429s; burst above the ceiling and successful recovery | Unassigned | Pending | Pending | not_run |

Use [configuration manifests](crm-manifest.md), [durable intake](intake-reference.md),
[workflow recipes](crm-workflow-recipes.md) and [recovery](crm-recovery.md) for the
concrete contracts. Keep recipes disabled until real bindings, grants and
approval/delivery channels are qualified. Notification acceptance and a queued
outbox record are distinct from confirmed delivery. Optional digest prose
never changes membership, inventory, payment or consent authority.

Only the named owners can authorize live data import and sole-record cutover
after automated acceptance and all applicable manual gates. Pushes, production
migrations/deployments, provider accounts/websites, cloud/systemd wiring,
off-instance drills, staff exercises and measured soak are external handoff
work. Native waitlist status, automatic promotion and a plugin marketplace are
separate product follow-ups.

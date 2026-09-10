# CRM backup and recovery

These Node 22/PostgreSQL 18 tools create encrypted recovery evidence. A local
proof establishes engineering behavior. The deployment owner must still wire
backup/archive schedules, custody, off-instance storage and alerts, and measure
an off-instance restore before sole-record cutover.

## Choose the recovery contract

- **Full restore:** a consistent `pg_dump` custom archive, selected table hashes,
  file snapshot and configuration inventory.
- **Point-in-time recovery:** a separate `pg_basebackup` tar archive and an
  uninterrupted sequence of archived WAL through the selected recovery point.
  A logical dump cannot be combined with WAL to provide PITR.
- **Erasure checkpoint:** the current protected journal, exported separately
  after the backup. Restoring older data must not undo completed erasures.

The implementation follows the [PostgreSQL continuous-archiving
contract](https://www.postgresql.org/docs/18/continuous-archiving.html) and
[pg_basebackup](https://www.postgresql.org/docs/18/app-pgbasebackup.html).
Physical backup currently refuses external tablespaces: qualify their mapping
before adding them. Use the same PostgreSQL major and extension versions.

## Private configuration

Create a new 32-byte random encryption key with mode `0600`; keep a recoverable
copy under the deployment owner's custody outside the backed-up machine. Do not
put the key or database password in shell arguments, Git or a report. The
configuration is an owner-private regular JSON file:

```json
{
  "pgBin": "/opt/postgresql/18/bin",
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "user": "backup_operator",
    "password": "REPLACE_IN_THIS_PRIVATE_FILE",
    "database": "brian",
    "sslmode": "disable"
  },
  "applicationSha": "REPLACE_WITH_THE_EXACT_40_CHARACTER_RELEASE_SHA",
  "applicationDirty": false,
  "keyFile": "/secure/recovery/aes256.key",
  "keyReference": "vault/recovery/key-v1",
  "protectedKeyReferences": [
    "vault/connector-encryption/key-v1",
    "vault/crm-suppression/keyring-v1"
  ],
  "quiescedSnapshot": true,
  "proofTables": [
    "entities", "crm_intake_idempotency", "association_memberships",
    "association_ticket_types", "association_orders"
  ],
  "fileRoots": [
    {"label": "objects", "kind": "files", "path": "/snapshots/workspace-objects"},
    {"label": "configuration", "kind": "config", "path": "/snapshots/configuration"}
  ],
  "journalMaxAgeSeconds": 300,
  "walArchiveDirectory": "/secure/recovery/wal"
}
```

The periods and paths above are fictional configuration examples, not approved
RPO or retention policy. Remote database connections default to verified TLS;
choose `verify-full` with the host's trusted CA. `require` encrypts without host
verification and must be an explicit operator choice. The backup principal
needs all data plus PostgreSQL metadata/physical-backup authority. This is an
administrative backup tool, never an application integration credential.

`quiescedSnapshot` is an operator attestation that the files/configuration and
database represent a coordinated snapshot. Stop mutations/workers or use a
qualified storage snapshot. The logical dump uses an exported SQL snapshot;
files are checked again after copying. That detects changes but cannot make
independent storage transactionally consistent. Physical content comparisons
also require a stable selected set or explicit `expectedProofs` for the target.
File roots accept regular files only. `files` roots use canonical object keys
`<workspace UUID>/<file UUID>` so replay can omit erased binaries. `config` and
`secrets` roots retain their inventory; all kinds are encrypted.

## Backup and checkpoint

```sh
node scripts/operations/brian-backup.mjs --config /secure/recovery/config.json
node scripts/operations/brian-backup.mjs --config /secure/recovery/config.json --execute --destination /backups/new-logical-backup
node scripts/operations/brian-backup.mjs --config /secure/recovery/config.json --mode journal --execute --destination /backups/new-journal-checkpoint
```

Default is read-only preflight. Execution refuses an existing destination and
uses argument arrays for PostgreSQL tools. `manifest.enc`, database/file
artifacts and journal checkpoints use AES-256-GCM with authenticated names.
The manifest records source cluster/database identity, code SHA/dirty state,
actual migration names, semantic schema hash, PostgreSQL/extension versions,
roles, key references, counts and exact content hashes. Role passwords are not
dumped by the logical path. Restore recreates role prerequisites with no login
or elevated rights and owns objects under its temporary recovery principal.
The physical archive contains the cluster's protected role/configuration state
and is always encrypted. Source credentials and hooks never become startup
configuration in the restored cluster.

The current checkpoint must cover the same source and schema, be captured after
backup completion, and meet the explicit freshness window. Its timestamp is
the SQL snapshot time, not export completion time. Migration 522 starts journal
coverage; earlier destructive operations need owner-qualified recovery evidence.
The v1 checkpoint envelope is bounded to 64 MiB and fails explicitly above it;
qualify partitioned journal storage before approaching that bound. No journal
deletion policy is inferred. Retention must preserve every checkpoint needed
for the still-retained backups, with privacy-owner approval.

Plaintext staging exists briefly in an owner-private directory while PostgreSQL
exports or restores. It is removed on completion/failure. Use encrypted local
storage as well; unlinking cannot promise physical erasure of old filesystem
blocks. A failed backup or upload records a failed receipt and exits nonzero.

## Continuous WAL and physical backups

Create an owner-private WAL directory and private configuration containing
`keyFile`, `keyReference` and `walArchiveDirectory`. Configure PostgreSQL's
`wal_level=replica`, `archive_mode=on`, and an `archive_command` invoking:

```text
/absolute/node /absolute/use-brian/scripts/operations/brian-wal-archive.mjs --config /secure/recovery/wal.json --source %p --name %f
```

Use PostgreSQL/shell quoting appropriate to the deployment paths. The tool
encrypts, fsyncs and atomically installs each segment. Repeated identical
segments succeed; an existing name with different content fails without
overwriting it. Missing keys, malformed names, disk failures and incomplete
archives fail visibly. No cloud request is implicit in this command.

After a completed archived segment is visible:

```sh
node scripts/operations/brian-backup.mjs --config /secure/recovery/config.json --mode physical
node scripts/operations/brian-backup.mjs --config /secure/recovery/config.json --mode physical --execute --destination /backups/new-physical-backup
```

Keep every required WAL segment and timeline history from the base-backup start
through the recovery point. A recent base backup alone does not establish WAL
continuity. The manifest records archive success/failure counters and dates.

## Disposable restore proof

```sh
node scripts/operations/brian-restore-check.mjs --config /secure/recovery/config.json --backup /backups/new-logical-backup --journal /backups/new-journal-checkpoint/journal.enc
node scripts/operations/brian-restore-check.mjs --config /secure/recovery/config.json --backup /backups/new-logical-backup --journal /backups/new-journal-checkpoint/journal.enc --execute --destination /scratch/new-restore-proof
```

Execution creates a new loopback-only cluster, port, database and data directory.
It refuses an existing target and an inherited remote database URL. It never
loads `.env`. It verifies authenticated artifacts, semantic schema/migrations,
selected row hashes, file hashes and all validated foreign-key constraints.
It then applies journal entries absent from the restored database. Database
triggers are suspended only inside that private replay transaction, and foreign
keys are checked before commit. Erased canonical object keys are omitted from
restored file snapshots, including erasures already represented in recovered WAL.

For PITR, set `recoveryTargetTime` to an explicit UTC timestamp after base-backup
completion, select the physical backup and provide the encrypted WAL directory.
Recovery strips source startup configuration, replication endpoints, archive
commands, preload libraries and network listeners. Only its owned WAL restore
command is installed. Missing WAL or an unreachable target fails the proof.
Where selected content changed before the target, supply independently reviewed
`expectedProofs` with that target's counts/hashes; never bless an observed
mismatch by copying it into the expected value.

No app or sending worker starts. The exported `restoreCheck()` accepts a trusted
`verifyApplication` callback for the deployment-specific application rehearsal.
The bundled contract harness supplies one for synthetic contact lookup, durable
intake replay, sendability/suppression, effective membership, inventory and order
reads. Without that callback, the CLI records the completed storage checks but
returns `blocked` for application acceptance. It never labels an incomplete
rehearsal green. After the callback, the tool stops/removes its own cluster and
decrypted files and retains `report.json` and the private PostgreSQL log. Failure
to stop preserves the owned directory and fails rather than deleting a live
cluster. Physical/off-instance application rehearsal remains deployment work.

## Off-instance storage and monitoring

An optional private `uploadHook` is an absolute executable plus argument array;
`{artifact}` expands to the completed encrypted artifact directory. Hooks run
only when explicitly configured, use no shell, and propagate failure. They
receive a clean runtime environment; the wrapper must retrieve credentials
through its own protected identity/configuration. No hook from a backup
manifest is executed during restore.

For example, a deployment-owned wrapper can invoke Azure CLI with managed
identity and a fictional destination:

```text
az storage blob upload-batch --auth-mode login --account-name fictionalrecovery --destination encrypted-crm --source <artifact-directory> --overwrite false
```

Provisioning or running this against a real account is outside local acceptance.
Verify encryption, object immutability, access, retention and restore credentials
from a separate machine. Backups are immutable evidence, not a second contact
ledger to edit by hand.

Record owner-selected RPO/RTO and alert on backup age, last successful archive
age, archive failures, WAL growth, free disk, failed uploads and failed restore
proofs. Test the alerts. Retain WAL according to all surviving base backups and
recovery objectives. Take a pre-upgrade snapshot, rehearse migrations in staging,
and pin compatible code plus schema. Code rollback cannot undo forward-only
migrations. Before restarting sending, reconcile current erasures and provider
state, external storage cleanup, queue leases and uncertain delivery receipts.

| Required decision/evidence | Owner | Date | Evidence |
|---|---|---|---|
| RPO/RTO and backup/WAL/journal schedules | | | |
| Encryption keys and independent recovery custody | | | |
| Off-instance restore and application callback | | | |
| Backup/archive/disk/queue alerts exercised | | | |
| Journal retention, pre-522 coverage and external erasure | | | |
| Staging migration and release/schema compatibility | | | |
| Sending restart and uncertain-provider reconciliation | | | |

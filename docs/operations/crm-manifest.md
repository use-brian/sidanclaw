# CRM configuration manifests

Use `scripts/crm/apply-manifest.mjs` to preview and apply version-1 workspace
configuration. It covers custom fields, pipelines/stages, consent purposes,
entitlement plans, events, intake definitions and segments. It does not import
contacts, approve privacy policy, enable Association, process payments or send
messages. Applying to an actual workspace requires that workspace's operator.

## Prepare and preview

Use Node 22 and build the canonical schemas from the OSS root:

```sh
pnpm --filter @use-brian/core build
node scripts/crm/apply-manifest.mjs --help
```

Start from `scripts/crm/fixtures/community-manifest.v1.json`, which contains only
fictional configuration. Read its wording and event dates before adapting it.
Every entry has a local `ref` and a canonical business `value`; stages identify
their parent with `pipelineRef`. An optional existing `id` binds a known item.
Use an explicit id to rename a pipeline or stage. Stable keys and custom-field
types cannot be renamed or converted by applying a different identity.

Supply an explicit API origin and workspace. Store the credential through your
secret manager in an owner-private regular file (mode 0600), or expose it in an
explicitly named environment variable. Never put the token value in command
arguments, the manifest or a report. This example uses a fictional destination:

```sh
node scripts/crm/apply-manifest.mjs \
  --manifest scripts/crm/fixtures/community-manifest.v1.json \
  --api-url https://crm.example \
  --workspace 00000000-0000-4000-8000-000000000001 \
  --mode integration \
  --token-file /private/operator/crm-token
```

For environment custody, replace `--token-file PATH` with `--token-env NAME`.
For a member session use `--mode member`; configuration commands require the
member's current owner/admin role. An integration key must match the explicit
workspace. The client refuses HTTP redirects and non-HTTPS destinations except
loopback. The manifest must be a regular JSON file no larger than 4 MiB.

The default invocation performs GET requests only and prints one JSON report.
`status: preview` with exit 0 means the projected configuration passed validation.
Inspect `changes`, including canonical defaults. An omitted optional property
is preserved, while schema defaults are controlled values. Omitted resources
are untouched. Version 1 refuses archived matches and archive requests; use
the existing settings controls for deliberate lifecycle changes.

## Integration grants

Grant only the resources required by the intended manifest. Catalog discovery
uses `crm.records.read` for fields/pipelines and `crm.catalog.read` for purposes,
plans, events and intake definitions. Creation requires explicit `all` for the
corresponding catalog selector because the new id does not exist yet. Global
field/pipeline/stage configuration requires `crm.catalog.configure` with `all`
for `definitionIds`, `purposeKeys`, `planIds` and `eventIds`.

Segment discovery includes a derived workspace catalog. It additionally requires
global consent, entitlement and participation read grants, and global catalog
read selectors. Saving a segment uses `crm.records.write`; catalog configuration
alone does not grant that operation. The API rechecks current credentials and
selectors when each command executes. A revoked, expired or insufficient key
stops application; the report never treats denial as success.

## Apply and recover

After reviewing the preview, run the same command with `--apply`. Each resource
command commits independently, in dependency order. The CLI re-reads before
each changed resource, refuses conflicting concurrent changes and checks that
the final residual diff is empty. It uses discovered ids and versions, not a
separate local mapping database.

An identical second apply must report `commandsIssued: 0`, `changes: []` and
`residual: []`. It creates no additional versions or audit rows. The application
does not infer an archive, reorder or deletion from an omitted entry.

On failure, inspect `completed`, `failed` and `error`. Outcomes distinguish a
confirmed command response, already satisfied current state, and an uncertain
response reconciled by reading equivalent state. The CLI never retries an
uncertain mutation blindly. Fix the reported cause and run preview again;
already committed resources are discovered under their stable identities.
Apply again only after reviewing the remaining diff.

Exit 1 means failure or partial apply. SIGINT produces exit 130 and SIGTERM exit
143 when the process can return a report. A request interrupted after dispatch
may have committed remotely. Even if a process dies before printing its report,
a fresh preview reads the current workspace before proposing further commands.
Never assume that a missing response proves no change occurred.

Invalid mappings report the accepted type or catalog values. Sensitive intake
fields must use `submission_only`. Consent mappings must reference an available
purpose and wording for each selected locale; `wordingVersion` is a string.
Trusted identity verification remains in the owner-managed settings flow and
cannot be introduced or downgraded by a manifest. Entity-reference custom fields
can be configured, but public intake mapping to entity references is unsupported
in version 1 and fails explicitly.

Local disposable-database tests prove the CLI contract. Production application,
staff exercises, legal approval and operational readiness remain separate gates.

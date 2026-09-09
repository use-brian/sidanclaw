# Provider webhook and reconciliation reference

This fictional loopback reference verifies the integration contract. It does
not charge a card, use a provider SDK or supply a production webhook endpoint.
Brian's canonical order binding and normalized inbox remain the business
boundary. `applied` proves a committed transition; a notification requires its
own delivery receipt.

Build the core package with Node 22.13 or later, then inspect the launcher:

```sh
pnpm --filter @use-brian/core build
node scripts/crm/reference-provider-backend.mjs --help
```

Copy `scripts/crm/fixtures/provider-events.json` to a private local scratch file.
Use a disposable Brian workspace: create its fictional contact, membership plan,
event, paid ticket and pending order through the regular APIs. Replace the
fixture's reserved IDs with those fixture IDs. Bind the order using
`POST /api/crm/integration/association/orders/:id/provider-binding` with the same
provider reference, amount and currency as the normalized event. Do not bind an
object from an unverified browser callback.

An owner issues a CRM integration key for `association.provider_events.write`
with the order event and `fixture` provider selectors, plus
`crm.entitlements.write` for the fixture plan. Supply it in `BRIAN_CRM_TOKEN`.
Supply a private random webhook secret of at least 32 characters in
`BRIAN_FIXTURE_WEBHOOK_SECRET`, and a different private backend bearer value in
`BRIAN_PROVIDER_BACKEND_TOKEN`. No secret goes in the fixture, checkpoint or
command arguments. The client checks the credential's workspace against the
configured fixture workspace before forwarding, including after key rotation.

Run preflight, then explicitly execute the chosen mode:

```sh
node scripts/crm/reference-provider-backend.mjs \
  --fixture /private/tmp/provider-events.json \
  --checkpoint /private/tmp/provider-reference/checkpoint.sqlite \
  --api-url http://127.0.0.1:3001

node scripts/crm/reference-provider-backend.mjs \
  --fixture /private/tmp/provider-events.json \
  --checkpoint /private/tmp/provider-reference/checkpoint.sqlite \
  --api-url http://127.0.0.1:3001 --once
```

`--once` processes at most 1,000 events and exits nonzero if blocked, waiting or
more remain. `--serve --interval-seconds 60` instead starts a loopback webhook
server and a bounded periodic reconciler. Its printed URL accepts a signed
`POST /webhook`; use `createFakeProvider().signWebhook(envelope)` from
`scripts/crm/provider-reference.mjs` to obtain the exact bytes and
`x-fixture-signature` header. The signature uses timestamped HMAC over those
bytes and has a five-minute freshness window. Do not stringify signed data
again before sending. Duplicate webhook and poll deliveries keep the same event
identity.

`GET /reconciliation` requires the private backend bearer token. It shows the
last scan, checkpoint and paginated durable receipt pointers. Use `cursor` and
`limit` to inspect every pointer, then read current Brian receipt history via
`GET /api/crm/integration/association/provider-receipts` with the appropriate
read grants. Pointer states are observations at admission time, not continuing
claims about the receipt. The cursor can be caught up while a receipt still
needs reconciliation. Repair the cause and replay the identical event with
current authorized credentials; do not mint a new event id to bypass a conflict.

A timeout before the response leaves the cursor unchanged. A timeout after
Brian commits behaves identically at this boundary: stable replay recovers its
receipt. HTTP 429 persists Retry-After before another polling attempt. A crash
after acceptance but before the SQLite checkpoint likewise replays. Separate
processes lease the same private checkpoint; stale owners cannot advance it.
The provider ledger must retain stable order/cursors and all events needed for
the agreed outage horizon. If provider history has expired, stop and reconcile
current objects explicitly; never skip an unknown interval.

A production adapter implements `verifyWebhook(rawBytes,signature)` and
`listEvents({cursor,limit})`, retaining exact provider identities. For a
Stripe-oriented adapter, verify the raw webhook signature, retrieve missing
PaymentIntent state, and map a verified successful payment's bound object,
amount and currency to `paid`. Map only a successful cumulative full refund to
`refunded`; partial or pending refunds need explicit resolution. Subscription
period evidence uses an immutable period id, finite dates, and the canonical
membership commands. Period-end cancellation changes renewal mode; immediate
cancellation changes status; renewal after a terminal period creates a new grant
with predecessor linkage. Duplicate/out-of-order events are normal and never
justify overwriting newer truth. See [Stripe webhook guidance](https://docs.stripe.com/webhooks),
[PaymentIntent fields](https://docs.stripe.com/api/payment_intents/object) and
[refund fields](https://docs.stripe.com/api/refunds/object).

Production accounts, SDK/signature mapping, webhook deployment, provider polling
retention and a controlled outage rehearsal remain integration-owner acceptance.

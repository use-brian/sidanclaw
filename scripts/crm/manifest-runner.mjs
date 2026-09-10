/** Canonical command application with fresh discovery and recovery. [COMP:crm/manifest] */
import { CrmOperationsUuidSchema } from '../../packages/core/dist/crm/operations-types.js'
import { ManifestError, parseManifest, discoverManifestCatalogs } from './manifest-client.mjs'
import { planManifest, manifestCommand, sameManifestBefore } from './manifest-plan.mjs'

const paths = { consentPurposes: 'consent-purposes', entitlementPlans: 'entitlement-plans', events: 'events', intakeDefinitions: 'intake-definitions', segments: 'segments' }
const safeError = (error) => error instanceof ManifestError ? { code: error.code, ...error.details } : { code: 'manifest_failed' }
const uncertain = (error) => ['request_uncertain', 'malformed_response', 'response_too_large', 'malformed_command_result'].includes(error?.code)
  || (error?.code === 'request_failed' && error.details.status >= 500)

async function execute(client, step, command) {
  let path = '/operations/commands', body = command, method = 'POST'
  if (client.mode === 'member' && paths[step.resource]) {
    path = `/operations/${paths[step.resource]}`
    const { kind: _kind, ...business } = command
    body = business
    if (step.resource === 'segments' && step.id) {
      path += `/${step.id}`; method = 'PATCH'
      const { segmentId: _id, ...patch } = business
      body = patch
    }
  }
  const response = await client.request(path, { method, body })
  if (!response || response.command !== command.kind || !CrmOperationsUuidSchema.safeParse(response.record?.id).success) {
    throw new ManifestError('malformed_command_result', { ref: step.ref })
  }
  if (step.id && response.record.id !== step.id) throw new ManifestError('malformed_command_result', { ref: step.ref })
  return response.record.id
}

export async function runManifest(client, input, { apply = false, signal } = {}) {
  const report = { schemaVersion: 1, workspaceId: client.workspaceId, mode: apply ? 'apply' : 'preview',
    status: 'failed', changes: [], completed: [], commandsIssued: 0 }
  let active = null
  try {
    const manifest = parseManifest(input)
    report.sourceLabel = manifest.sourceLabel
    const initial = planManifest(manifest, await discoverManifestCatalogs(client, manifest))
    report.changes = initial.changes
    if (!apply) { report.status = 'preview'; return report }
    for (const initialStep of initial.steps.filter((step) => step.action !== 'none')) {
      active = initialStep.ref
      if (signal?.aborted) throw new ManifestError('interrupted')
      const fresh = planManifest(manifest, await discoverManifestCatalogs(client, manifest))
      const step = fresh.steps.find((item) => item.ref === active)
      if (!step) throw new ManifestError('configuration_disappeared', { ref: active })
      if (step.action === 'none') {
        report.completed.push({ ref: active, id: step.id, outcome: 'observed_satisfied' })
        continue
      }
      if (!sameManifestBefore(initialStep, step)) throw new ManifestError('concurrent_configuration_change', { ref: active })
      const command = manifestCommand(step)
      try {
        // Count a submitted command even when its result is uncertain.
        report.commandsIssued++
        const id = await execute(client, step, command)
        report.completed.push({ ref: active, id, outcome: 'command_confirmed' })
      } catch (error) {
        const mayReconcile = uncertain(error) || (error?.code === 'request_failed' && error.details.status === 409)
        if (!signal?.aborted && mayReconcile) {
          try {
            const recovered = planManifest(manifest, await discoverManifestCatalogs(client, manifest)).steps.find((item) => item.ref === active)
            if (recovered?.action === 'none') {
              report.completed.push({ ref: active, id: recovered.id, outcome: 'reconciled_by_read' })
              continue
            }
          } catch { /* Preserve the original failed/uncertain write, not a read error. */ }
        }
        report.failed = { ref: active, uncertain: uncertain(error), error: safeError(error) }
        throw error
      }
    }
    active = null
    const residual = planManifest(manifest, await discoverManifestCatalogs(client, manifest)).changes
    if (residual.length) {
      report.residual = residual
      throw new ManifestError('residual_configuration_drift')
    }
    report.status = 'applied'
    report.residual = []
  } catch (error) {
    report.error = signal?.aborted ? { code: 'interrupted' } : safeError(error)
    if (!report.failed && active) report.failed = { ref: active, uncertain: false, error: report.error }
  }
  return report
}

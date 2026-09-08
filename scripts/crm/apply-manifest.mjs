#!/usr/bin/env node
/** Operator JSON preview/apply entry point. [COMP:crm/manifest] */
import { open, constants } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const HELP = `Usage: node scripts/crm/apply-manifest.mjs --manifest PATH --api-url ORIGIN --workspace UUID --mode member|integration (--token-env NAME | --token-file PATH) [--apply]

Build first: pnpm --filter @use-brian/core build
Default is a read-only JSON diff. --apply submits canonical configuration commands.
Use a private token source; never put a token in argv or the manifest.
Exit: 0 successful preview/apply, 1 failed/partial, 130 interrupted, 143 terminated.
`

export async function manifestMain(args = process.argv.slice(2)) {
  let token, interrupted = 0
  const abort = new AbortController()
  const onInt = () => { interrupted = 130; abort.abort() }
  const onTerm = () => { interrupted = 143; abort.abort() }
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
      manifest: { type: 'string' }, 'api-url': { type: 'string' }, workspace: { type: 'string' }, mode: { type: 'string' },
      'token-env': { type: 'string' }, 'token-file': { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' },
    } })
    if (values.help) { process.stdout.write(HELP); return 0 }
    // Dynamic imports keep --help usable before build and avoid the aggregate
    // core index's non-JSON startup output.
    const { createManifestClient, readManifestToken, ManifestError } = await import('./manifest-client.mjs')
    const { runManifest } = await import('./manifest-runner.mjs')
    if (!values.manifest || !values['api-url'] || !values.workspace || !values.mode) throw new ManifestError('required_arguments_missing')
    token = await readManifestToken({ tokenEnv: values['token-env'], tokenFile: values['token-file'] })
    const file = await open(values.manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let input
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new ManifestError('invalid_manifest_file')
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4 * 1024 * 1024) throw new ManifestError('manifest_too_large')
      const text = bytes.subarray(0, bytesRead).toString('utf8')
      if (text.includes(token)) throw new ManifestError('credential_in_manifest')
      try { input = JSON.parse(text) } catch { throw new ManifestError('invalid_manifest_json') }
    } finally { await file.close() }
    const client = createManifestClient({ apiUrl: values['api-url'], workspaceId: values.workspace, mode: values.mode, token, signal: abort.signal })
    const result = await runManifest(client, input, { apply: values.apply, signal: abort.signal })
    // Even an unexpected server-controlled catalog string cannot echo the
    // supplied secret into the operator's report.
    process.stdout.write(JSON.stringify(result, null, 2).split(token).join('[redacted]') + '\n')
    return interrupted || (result.status === 'failed' ? 1 : 0)
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'manifest_startup_failed'
    process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'failed', error: { code: interrupted ? 'interrupted' : code } }) + '\n')
    return interrupted || 1
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await manifestMain()

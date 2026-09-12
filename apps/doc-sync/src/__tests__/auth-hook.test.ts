import { describe, it, expect } from 'vitest'
import { resolveAuth } from '../auth-hook.js'
import { DRAWING_PROTOCOL } from '@use-brian/doc-model'

describe('[COMP:doc-sync/auth] resolveAuth', () => {
  const jwtSecret = 'secret'
  it('verifies the JWT inside the versioned capability and never unwraps a service secret into privilege', () => {
    expect(resolveAuth({ token: `${DRAWING_PROTOCOL}jwt`, jwtSecret, verify: token => token === 'jwt' ? 'user' : null }))
      .toEqual({ kind: 'user', userId: 'user', drawingProtocol: DRAWING_PROTOCOL })
    expect(resolveAuth({ token: `${DRAWING_PROTOCOL}svc`, jwtSecret, syncSecret: 'svc', verify: () => null }).kind).toBe('reject')
  })

  it('rejects a missing or blank token', () => {
    expect(resolveAuth({ token: undefined, jwtSecret }).kind).toBe('reject')
    expect(resolveAuth({ token: '   ', jwtSecret }).kind).toBe('reject')
  })

  it('accepts the shared sync secret as a service connection', () => {
    expect(
      resolveAuth({ token: 'svc-xyz', jwtSecret, syncSecret: 'svc-xyz' }),
    ).toEqual({ kind: 'service' })
  })

  it('prefers the service secret over JWT verification', () => {
    const r = resolveAuth({
      token: 'svc',
      jwtSecret,
      syncSecret: 'svc',
      verify: () => 'should-not-be-used',
    })
    expect(r).toEqual({ kind: 'service' })
  })

  it('resolves a valid token to its userId via the injected verifier', () => {
    const r = resolveAuth({
      token: 'good',
      jwtSecret,
      verify: (t) => (t === 'good' ? 'user-1' : null),
    })
    expect(r).toEqual({ kind: 'user', userId: 'user-1' })
  })

  it('rejects an invalid token', () => {
    expect(resolveAuth({ token: 'bad', jwtSecret, verify: () => null })).toEqual({
      kind: 'reject',
      reason: 'invalid_token',
    })
  })
})

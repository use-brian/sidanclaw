import { describe, expect, it } from 'vitest'

import { personExternalRefsFor } from '../enrichment-worker.js'

describe('personExternalRefsFor', () => {
  const base = {
    window_id: 'w1',
    source_ref: { archive_instance_id: 'inst-1' } as Record<string, unknown>,
    owner_user_id: 'o', workspace_id: 'ws', rendered_text: 't',
    message_count: 1, window_start: '', window_end: '',
    attempt_count: 0, lease_expires_at: '',
  }

  it('keys a provider-verified ref on the name the window rendered', () => {
    expect(personExternalRefsFor({
      ...base,
      participants: [{ sender_id: '8529@s.whatsapp.net', display_name: 'TW' }],
    })).toEqual([
      {
        name: 'TW',
        externalRef: { provider: 'whatsapp', id: '8529@s.whatsapp.net', instance_id: 'inst-1' },
      },
    ])
  })

  it('carries the phone the store resolved, and omits it when there is none', () => {
    expect(personExternalRefsFor({
      ...base,
      participants: [
        { sender_id: '85268719565@s.whatsapp.net', display_name: 'Cindy', phone: '+85268719565' },
        { sender_id: '176450292473999@lid', display_name: '屈狗' },
      ],
    })).toEqual([
      {
        name: 'Cindy',
        externalRef: { provider: 'whatsapp', id: '85268719565@s.whatsapp.net', instance_id: 'inst-1' },
        phone: '+85268719565',
      },
      {
        name: '屈狗',
        externalRef: { provider: 'whatsapp', id: '176450292473999@lid', instance_id: 'inst-1' },
      },
    ])
  })

  it('skips a participant the store left unnamed', () => {
    // Either nameless or sharing a name with another sender — no name can
    // select them, and guessing would bind one person's messages to another.
    expect(personExternalRefsFor({
      ...base,
      participants: [
        { sender_id: 'aaa@s.whatsapp.net', display_name: '' },
        { sender_id: 'bbb@s.whatsapp.net', display_name: 'Cindy' },
      ],
    })).toEqual([
      {
        name: 'Cindy',
        externalRef: { provider: 'whatsapp', id: 'bbb@s.whatsapp.net', instance_id: 'inst-1' },
      },
    ])
  })

  it('emits nothing without the connector instance namespace', () => {
    expect(personExternalRefsFor({
      ...base,
      source_ref: {},
      participants: [{ sender_id: '8529@s.whatsapp.net', display_name: 'TW' }],
    })).toEqual([])
  })

  it('tolerates a store that sends no participants', () => {
    expect(personExternalRefsFor(base)).toEqual([])
  })
})

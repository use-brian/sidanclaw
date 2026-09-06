import { describe, expect, it } from 'vitest'
import { HOME_APP_TOOL_CONFIG, HOME_APP_TOOL_CAPABILITIES, homeAppToolRequirements, homeAppToolSetCapability } from '../home-app-tool-config.js'

describe('[COMP:shared/home-app-tool-config] mini-app tool declarations', () => {
  it('declares the requested six apps with unique app and set grants', () => {
    expect(HOME_APP_TOOL_CONFIG.map((app) => app.id)).toEqual(['page', 'office', 'browsers', 'tasks', 'crm', 'feed'])
    expect(new Set(HOME_APP_TOOL_CAPABILITIES).size).toBe(HOME_APP_TOOL_CAPABILITIES.length)
  })
  it.each(HOME_APP_TOOL_CONFIG)('requires the $id app AND its selected set', (app) => {
    expect(homeAppToolRequirements({ requiresCapability: app.capability, isReadOnly: true }))
      .toEqual([app.capability, homeAppToolSetCapability(app.id, 'read')])
    expect(homeAppToolRequirements({ requiresCapability: app.capability, isReadOnly: false }))
      .toEqual([app.capability, homeAppToolSetCapability(app.id, 'write')])
  })
  it('supports explicit app metadata on injected tools and refuses undeclared sets', () => {
    expect(homeAppToolRequirements({ isReadOnly: false, homeAppToolSet: { app: 'feed', set: 'write' } }))
      .toEqual(['feed', 'home_app:feed:write'])
    expect(homeAppToolRequirements({ isReadOnly: true, homeAppToolSet: { app: 'page', set: 'undeclared' } }))
      .toEqual(['home_app:unknown'])
    expect(homeAppToolRequirements({ isReadOnly: true })).toEqual([])
  })
})

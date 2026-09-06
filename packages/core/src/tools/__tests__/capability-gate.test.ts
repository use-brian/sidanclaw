import { createDocTools } from '../../doc/tools.js'
import { createFindPageTool } from '../../doc/find-page.js'
import { createViewTools, createRenderChartTool } from '../../views/tools.js'
import { HOME_APP_TOOL_CONFIG, homeAppToolSetCapability } from '@use-brian/shared'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool } from '../types.js'
import {
  filterToolsByCapabilities,
  isAutonomousToolContext,
  INTERACTIVE_CHANNEL_TYPES,
} from '../capability-gate.js'
import type { Tool } from '../types.js'

function makeTool(name: string, requiresCapability?: string): Tool {
  return buildTool({
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}),
    requiresCapability,
    execute: async () => ({ data: 'ok' }),
  })
}

function makeHiddenTool(name: string): Tool {
  return buildTool({
    name,
    description: `deprecated alias ${name}`,
    inputSchema: z.object({}),
    hiddenFromModel: true,
    execute: async () => ({ data: 'ok' }),
  })
}

describe('[COMP:tools/capability-gate] filterToolsByCapabilities', () => {
  const plainTool = makeTool('plain')
  const triageTool = makeTool('triage_reader', 'bug_triage')
  const costTool = makeTool('cost_peek', 'cost_audit')

  it('passes unrestricted tools through regardless of active caps', () => {
    const input = new Map<string, Tool>([['plain', plainTool]])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.size).toBe(1)
    expect(out.has('plain')).toBe(true)
  })

  it('drops capability-gated tools when the cap is not in the active set', () => {
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['triage_reader', triageTool],
    ])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.size).toBe(1)
    expect(out.has('plain')).toBe(true)
    expect(out.has('triage_reader')).toBe(false)
  })

  it('keeps a capability-gated tool when the cap is active', () => {
    const input = new Map<string, Tool>([['triage_reader', triageTool]])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage']))
    expect(out.size).toBe(1)
    expect(out.has('triage_reader')).toBe(true)
  })

  it('unrelated active cap does not unlock a differently-gated tool', () => {
    const input = new Map<string, Tool>([
      ['triage_reader', triageTool],
      ['cost_peek', costTool],
    ])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage']))
    expect(out.size).toBe(1)
    expect(out.has('triage_reader')).toBe(true)
    expect(out.has('cost_peek')).toBe(false)
  })

  it('drops hiddenFromModel tools so the model never sees them (callable but hidden)', () => {
    // The scheduled-job verbs are folded into the workflow surface: kept
    // callable for back-compat, removed from the model's tool list.
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['createScheduledJob', makeHiddenTool('createScheduledJob')],
    ])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.has('plain')).toBe(true)
    expect(out.has('createScheduledJob')).toBe(false)
  })

  it('drops hiddenFromModel tools regardless of active capabilities', () => {
    const input = new Map<string, Tool>([['scheduleWorkflow', makeHiddenTool('scheduleWorkflow')]])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage', 'cost_audit']))
    expect(out.size).toBe(0)
  })

  it('returns a fresh map (input unchanged)', () => {
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['triage_reader', triageTool],
    ])
    filterToolsByCapabilities(input, new Set())
    expect(input.size).toBe(2)
  })
})

describe('[COMP:tools/capability-gate] isAutonomousToolContext (Tier-C write-gate discriminator)', () => {
  // Interactive channels — a live human can tap Allow, so NOT autonomous.
  it.each(['web', 'telegram', 'slack', 'feishu', 'whatsapp', 'discord'])(
    'treats interactive channel %s as NOT autonomous',
    (channelType) => {
      expect(isAutonomousToolContext({ channelType })).toBe(false)
    },
  )

  // Autonomous / headless channels — no human present, so gated.
  it.each([
    'workflow', // scheduled jobs run THROUGH the workflow executor
    'assistant-call', // A2A callee
    'system', // background workers
    'synthesis',
    'notification',
    'home-refresh',
    'skill-draft',
    'api', // public API — no one to confirm in-line
    'programmatic', // brain-key MCP
    'cron',
  ])('treats headless channel %s as autonomous', (channelType) => {
    expect(isAutonomousToolContext({ channelType })).toBe(true)
  })

  it('is fail-closed — an unknown/new channel defaults to autonomous (gated)', () => {
    expect(isAutonomousToolContext({ channelType: 'some-new-headless-channel' })).toBe(true)
    expect(isAutonomousToolContext({ channelType: '' })).toBe(true)
  })

  it('the interactive allowlist is exactly the live-human channels', () => {
    // `custom` is a bridge-driven channel relaying a live human's chat
    // (docs/architecture/channels/custom-channel.md).
    expect([...INTERACTIVE_CHANNEL_TYPES].sort()).toEqual(
      ['custom', 'discord', 'feishu', 'slack', 'telegram', 'web', 'whatsapp'],
    )
  })
})


describe('[COMP:tools/capability-gate] mini-app sets', () => {
  it.each(HOME_APP_TOOL_CONFIG)('$id requires both parent and set, with independent read/write switches', (app) => {
    const read = buildTool({ name: 'readApp', description: 'read', inputSchema: z.object({}), requiresCapability: app.capability, isReadOnly: true, execute: async () => ({ data: 'read' }) })
    const write = buildTool({ name: 'writeApp', description: 'write', inputSchema: z.object({}), requiresCapability: app.capability, execute: async () => ({ data: 'write' }) })
    const tools = new Map([[read.name, read], [write.name, write]])
    const readCap = homeAppToolSetCapability(app.id, 'read')
    const writeCap = homeAppToolSetCapability(app.id, 'write')
    expect([...filterToolsByCapabilities(tools, new Set([app.capability, readCap])).keys()]).toEqual(['readApp'])
    expect([...filterToolsByCapabilities(tools, new Set([app.capability, writeCap])).keys()]).toEqual(['writeApp'])
    expect(filterToolsByCapabilities(tools, new Set([readCap, writeCap])).size).toBe(0)
    expect(filterToolsByCapabilities(tools, new Set([app.capability])).size).toBe(0)
    expect(filterToolsByCapabilities(tools, new Set([app.capability, readCap, writeCap])).size).toBe(2)
  })
  it('keeps an independent required capability on a late-injected Page tool', () => {
    const tool = { ...makeTool('readPageFile', 'files'), isReadOnly: true, homeAppToolSet: { app: 'page' as const, set: 'read' } }
    const tools = new Map([[tool.name, tool]])
    expect(filterToolsByCapabilities(tools, new Set(['page', 'home_app:page:read'])).size).toBe(0)
    expect(filterToolsByCapabilities(tools, new Set(['files', 'page', 'home_app:page:read'])).size).toBe(1)
  })
})


describe('[COMP:tools/capability-gate] Page factory coverage', () => {
  it('covers both collaborative Page tools and legacy page-producing tools', () => {
    const tools = [
      ...Object.values(createDocTools({} as never)),
      createFindPageTool({} as never),
      ...Object.values(createViewTools({} as never)),
      createRenderChartTool({} as never),
    ]
    const map = new Map(tools.map((tool) => [tool.name, tool]))
    expect(filterToolsByCapabilities(map, new Set(['views', 'home_app:page:read', 'home_app:page:write'])).size).toBe(0)
    const readOnly = filterToolsByCapabilities(map, new Set(['views', 'page', 'home_app:page:read']))
    expect(readOnly.has('findPage')).toBe(true)
    expect(readOnly.has('getCurrentPage')).toBe(true)
    for (const name of ['renderPage', 'patchPage', 'renderView', 'renderChart', 'saveView']) expect(readOnly.has(name), name).toBe(false)
  })
})

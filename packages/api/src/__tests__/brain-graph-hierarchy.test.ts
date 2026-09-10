import { describe, expect, it } from 'vitest'
import {
  projectBrainGraphHierarchy,
  type BrainGraphSourceEdge,
  type BrainGraphSourceNode,
} from '../brain-graph-hierarchy.js'

function graphOf(count: number): {
  nodes: BrainGraphSourceNode[]
  edges: BrainGraphSourceEdge[]
} {
  const kinds = ['person', 'company', 'knowledge', 'project']
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node-${String(index).padStart(5, '0')}`,
    kind: kinds[index % kinds.length]!,
    name: `Entry ${String(index).padStart(5, '0')}`,
    sensitivity: 'internal' as const,
    degree: index % 9,
  }))
  const edges: BrainGraphSourceEdge[] = []
  for (let index = 1; index < count; index += 1) {
    edges.push({
      id: `edge-${index}`,
      source: nodes[index - 1]!.id,
      target: nodes[index]!.id,
      type: 'related',
      sensitivity: 'internal',
    })
  }
  return { nodes, edges }
}

describe('[COMP:brain/graph-hierarchy] bounded Brain graph hierarchy', () => {
  it('returns a small graph as real entries without grouping', () => {
    const source = graphOf(40)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })

    expect(result.nodes).toHaveLength(40)
    expect(result.nodes.every((node) => node.nodeType !== 'group')).toBe(true)
    expect(result.totalNodes).toBe(40)
    expect(result.groupedNodeCount).toBe(0)
  })

  it('projects 5000 entries into a fixed-budget overview without member ids', () => {
    const source = graphOf(5_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: true,
    })

    expect(result.nodes.length).toBeLessThanOrEqual(60)
    expect(result.edges.length).toBeLessThanOrEqual(600)
    expect(result.nodes.every((node) => node.nodeType === 'group')).toBe(true)
    expect(result.groupedNodeCount).toBe(5_000)
    expect(result.totalNodes).toBe(5_000)
    expect(result.renderBudget).toEqual({ nodes: 200, edges: 600 })
    expect(JSON.stringify(result)).not.toContain('members')
  })

  it('opens one group into at most 160 real entries', () => {
    const source = graphOf(1_000)
    const overview = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })
    const group = overview.nodes.find((node) => node.nodeType === 'group')
    expect(group?.nodeType).toBe('group')

    const scoped = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      scopeId: group?.id,
    })

    expect(scoped.scopeId).toBe(group?.id)
    expect(scoped.nodes.length).toBeLessThanOrEqual(160)
    expect(scoped.nodes.every((node) => node.nodeType !== 'group')).toBe(true)
  })

  it('reveals the bounded scope containing a server-side search match', () => {
    const source = graphOf(1_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusQuery: 'Entry 00999',
    })

    expect(result.scopeId).not.toBeNull()
    expect(result.focusNodeIds).toContain('node-00999')
    expect(result.nodes.some((node) => node.id === 'node-00999')).toBe(true)
    expect(result.nodes.length).toBeLessThanOrEqual(160)
  })

  it('keeps group ids stable when source edge order changes', () => {
    const source = graphOf(800)
    const first = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })
    const second = projectBrainGraphHierarchy({
      nodes: [...source.nodes].reverse(),
      edges: [...source.edges].reverse(),
      truncated: false,
    })

    expect(first.nodes.map((node) => node.id).sort()).toEqual(
      second.nodes.map((node) => node.id).sort(),
    )
  })

  it('aggregates repeated relationships between groups into weighted edges', () => {
    const source = graphOf(400)
    // Cross-kind chords ensure several source relationships collapse onto the
    // same overview pair.
    for (let index = 0; index < 100; index += 1) {
      source.edges.push({
        id: `chord-${index}`,
        source: source.nodes[index]!.id,
        target: source.nodes[index + 200]!.id,
        type: index % 2 === 0 ? 'mentions' : 'related',
        sensitivity: index === 0 ? 'confidential' : 'internal',
      })
    }
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
    })

    expect(result.edges.some((edge) => edge.count > 1)).toBe(true)
    expect(result.edges.every((edge) => edge.source !== edge.target)).toBe(true)
  })
})

describe('[COMP:brain/graph-hierarchy] exact-id focus (chat-audit retrieval highlight)', () => {
  it('marks visible matches directly on a flat projection', () => {
    const source = graphOf(40)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusIds: ['node-00003', 'node-00007', 'not-a-node'],
    })
    expect(result.scopeId).toBeNull()
    expect(result.focusNodeIds).toEqual(['node-00003', 'node-00007'])
    expect(result.focusGroupCounts).toEqual({})
  })

  it('counts matches per visible group at the overview without opening a scope or leaking members', () => {
    const source = graphOf(1_000)
    const ids = ['node-00001', 'node-00002', 'node-00900']
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusIds: ids,
    })
    expect(result.scopeId).toBeNull()
    expect(result.nodes.every((node) => node.nodeType === 'group')).toBe(true)
    const total = Object.values(result.focusGroupCounts).reduce((a, b) => a + b, 0)
    expect(total).toBe(3)
    for (const groupId of Object.keys(result.focusGroupCounts)) {
      expect(result.nodes.some((node) => node.id === groupId)).toBe(true)
    }
    expect(JSON.stringify(result)).not.toContain('members')
    // Nothing is visible at the overview, so no direct matches are reported.
    expect(result.focusNodeIds).toEqual([])
  })

  it('reveal opens the scope holding the most matches and reports the visible ones', () => {
    const source = graphOf(1_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusIds: ['node-00001', 'node-00002', 'node-00003', 'node-00900'],
      revealFocus: true,
    })
    expect(result.scopeId).not.toBeNull()
    expect(result.nodes.length).toBeLessThanOrEqual(160)
    // The cluster of three neighbours wins over the lone far match.
    expect(result.focusNodeIds).toEqual(
      expect.arrayContaining(['node-00001', 'node-00002', 'node-00003']),
    )
    expect(result.focusNodeIds).not.toContain('node-00900')
  })

  it('an explicit scope wins over reveal, and unknown ids change nothing', () => {
    const source = graphOf(1_000)
    const overview = projectBrainGraphHierarchy({ ...source, truncated: false })
    const group = overview.nodes.find((node) => node.nodeType === 'group')
    const scoped = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      scopeId: group?.id,
      focusIds: ['nope-1', 'nope-2'],
      revealFocus: true,
    })
    expect(scoped.scopeId).toBe(group?.id)
    expect(scoped.focusNodeIds).toEqual([])
    expect(scoped.focusGroupCounts).toEqual({})
  })

  it('a query reveal keeps precedence over id focus for scope selection', () => {
    const source = graphOf(1_000)
    const result = projectBrainGraphHierarchy({
      ...source,
      truncated: false,
      focusQuery: 'Entry 00999',
      focusIds: ['node-00001'],
      revealFocus: true,
    })
    expect(result.focusNodeIds[0]).toBe('node-00999')
  })
})

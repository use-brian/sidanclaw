import { describe, expect, it } from 'vitest'
import { drawingBlockSchema, drawingSceneSchema, MAX_DRAWING_BYTES } from '../drawing.js'

const image = { id: 'e', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'f' }
const scene = { version: 1, elements: [image], appState: { viewBackgroundColor: '#fff' },
  files: { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 } } }

describe('[COMP:shared/drawing] scene boundary', () => {
  it('accepts legacy unnamed drawings and trims bounded optional titles', () => {
    const block = { kind: 'drawing', id: 'd', scene }
    expect(drawingBlockSchema.parse(block)).not.toHaveProperty('title')
    expect(drawingBlockSchema.parse({ ...block, title: '  Plan  ' }).title).toBe('Plan')
    expect(drawingBlockSchema.parse({ ...block, title: '   ' }).title).toBe('')
    expect(drawingBlockSchema.parse({ ...block, title: 'x'.repeat(200) }).title).toHaveLength(200)
    for (const title of ['x'.repeat(201), null, 42]) expect(drawingBlockSchema.safeParse({ ...block, title }).success).toBe(false)
  })
  it.each(['arrow', 'line', 'freedraw'])('rejects absent or malformed %s geometry', type => {
    const element = { id: 'geometry', type, x: 0, y: 0, width: 10, height: 10, simulatePressure: true, pressures: [] }
    for (const points of [undefined, null, {}, [], [null], [[0]], [[0, 0, 1]], [[0, 0], ['bad', 2]], [[0, 0], [Infinity, 2]]]) {
      expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...element, points }] }).success).toBe(false)
    }
    expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...element, points: [[0, 0], [10, 10]] }] }).success).toBe(true)
  })
  it('requires freehand pressure settings and text metrics, and checks optional geometry', () => {
    const free = { id: 'free', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]] }
    for (const element of [free, { ...free, simulatePressure: false, pressures: [0.5] },
      { ...free, type: 'text', text: 'Sketch' }, { ...image, scale: [1] },
      { ...free, type: 'arrow', fixedSegments: [{ start: null, end: [0, 1], index: 1 }] }]) {
      expect(drawingSceneSchema.safeParse({ ...scene, elements: [element] }).success).toBe(false)
    }
  })
  it('preserves editable elements, versioned fields, and image bytes', () => {
    const input = { ...scene, elements: [{ ...image, seed: 42, versionNonce: 123 }] }
    expect(drawingSceneSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input)
  })
  it('accepts nullable legacy binding IDs without accepting malformed bindings', () => {
    for (const boundElementIds of [null, [], ['bound-text']]) {
      const input = { ...scene, elements: [{ ...image, boundElementIds }] }
      expect(drawingSceneSchema.parse(input)).toEqual(input)
    }
    for (const boundElementIds of [42, [null], [42], {}]) {
      expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...image, boundElementIds }] }).success).toBe(false)
    }
  })
  it('refuses missing images, external assets, SVG, and metadata mismatches', () => {
    expect(drawingSceneSchema.safeParse({ ...scene, files: {} }).success).toBe(false)
    for (const dataURL of ['https://example.com/a.png', 'data:image/svg+xml;base64,YQ==', 'data:image/jpeg;base64,YQ==']) {
      expect(drawingSceneSchema.safeParse({ ...scene, files: { f: { ...scene.files.f, dataURL } } }).success).toBe(false)
    }
  })
  it('refuses oversized scenes, unsupported embeds, and links', () => {
    expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...image, customData: 'x'.repeat(MAX_DRAWING_BYTES) }] }).success).toBe(false)
    expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...image, type: 'embeddable' }] }).success).toBe(false)
    expect(drawingSceneSchema.safeParse({ ...scene, elements: [{ ...image, link: 'https://example.com' }] }).success).toBe(false)
    expect(drawingSceneSchema.safeParse({ ...scene, version: 2 }).success).toBe(false)
  })
})

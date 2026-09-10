import { describe, it, expect } from 'vitest'
import { drawingPreviewSchema, drawingSceneDigest, type DrawingScene } from '../drawing.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const preview = { mimeType: 'image/png', data: png, width: 1, height: 1, sceneDigest: 'a'.repeat(64) }
describe('drawing preview validation', () => {
  it('accepts a bounded inline PNG and rejects invalid metadata, URLs, bytes and dimensions', () => {
    expect(drawingPreviewSchema.safeParse(preview).success).toBe(true)
    for (const patch of [{ mimeType: 'image/jpeg' }, { width: 2 }, { height: 1601 }, { sceneDigest: 'old' },
      { data: 'https://private.example/image.png' }, { data: '<svg />' }, { data: 'YQ==' },
      { data: 'A'.repeat(1400000) }, { data: png.slice(0, -8) }]) {
      expect(drawingPreviewSchema.safeParse({ ...preview, ...patch }).success).toBe(false)
    }
  })
  it('binds all scene content independent of JSONB object key order', async () => {
    const scene: DrawingScene = { version: 1, elements: [], appState: { viewBackgroundColor: '#fff' }, files: {} }
    expect(await drawingSceneDigest(scene)).toBe(await drawingSceneDigest({ files: {}, appState: scene.appState, elements: [], version: 1 }))
    expect(await drawingSceneDigest(scene)).not.toBe(await drawingSceneDigest({ ...scene, appState: { viewBackgroundColor: '#000' } }))
  })
})

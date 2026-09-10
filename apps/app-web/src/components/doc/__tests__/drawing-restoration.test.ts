// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawingSceneSchema } from '@use-brian/shared/drawing';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

describe('[COMP:app-web/drawing] actual Excalidraw restoration', () => {
  afterEach(() => vi.restoreAllMocks());
  it('restores validated geometry with the installed runtime, not a mocked restorer', async () => {
    // The module probes canvas filter support at import. Restoration does not
    // paint; shim only that jsdom-missing browser capability, not the runtime.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const { restoreElements } = await import('@excalidraw/excalidraw');
    const base = { x: 0, y: 0, width: 100, height: 80 };
    const scene = drawingSceneSchema.parse({ version: 1, appState: { viewBackgroundColor: '#fff' },
      files: { image: { id: 'image', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 } }, elements: [
      { ...base, id: 'arrow', type: 'arrow', points: [[0, 0], [100, 80]] },
      { ...base, id: 'line', type: 'line', points: [[0, 0], [100, 80]] },
      { ...base, id: 'free', type: 'freedraw', points: [[0, 0], [100, 80]], simulatePressure: false, pressures: [0.3, 0.8] },
      { ...base, id: 'text', type: 'text', text: 'Sketch', fontSize: 20, fontFamily: 1 },
      { ...base, id: 'rectangle', type: 'rectangle' },
      { ...base, id: 'diamond', type: 'diamond' },
      { ...base, id: 'ellipse', type: 'ellipse' },
      { ...base, id: 'frame', type: 'frame' },
      { ...base, id: 'image', type: 'image', fileId: 'image', scale: [-1, 1] },
      { ...base, id: 'elbow', type: 'arrow', elbowed: true, points: [[0, 0], [100, 0], [100, 80]], fixedSegments: null },
    ] });
    const restored = restoreElements(scene.elements as unknown as ExcalidrawElement[], null, { repairBindings: true });
    expect(restored.map(element => element.id)).toEqual(scene.elements.map(element => element.id));
    expect(drawingSceneSchema.parse({ ...scene, elements: restored }).elements).toHaveLength(scene.elements.length);
    // Reproduce the actual pre-default access that made the old schema unsafe.
    expect(() => restoreElements([{ ...base, id: 'bad', type: 'arrow' }] as ExcalidrawElement[], null)).toThrow();
  }, 20_000);
});

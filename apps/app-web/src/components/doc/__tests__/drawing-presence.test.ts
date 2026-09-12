import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { bindDrawingPresence, drawingCollaborators } from '../drawing-presence';

const scope = 'drawing:block:epoch:base';
const state = () => ({ user: { id: 'same-account', name: 'Synthetic editor', color: '#3E63DD', avatarUrl: 'private' },
  cursor: { anchor: 'host' }, drawing: { scope, pointer: { x: 12, y: -5, tool: 'pointer' }, button: 'down', selected: ['shape'] } });
describe('[COMP:app-web/drawing-presence] transient scoped awareness', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps separate tabs, excludes self and other drawing epochs, and forwards only SDK fields', () => {
    const result = drawingCollaborators(new Map<number, Record<string, unknown>>([[1, state()], [2, state()], [3, state()],
      [4, { ...state(), drawing: { ...state().drawing, scope: 'other-epoch' } }], [5, { user: state().user }]]), 1, scope);
    expect([...result.keys()]).toEqual(['2', '3']);
    expect(result.get('2' as never)).toEqual({ socketId: '2', username: 'Synthetic editor',
      color: { background: '#3E63DD', stroke: '#3E63DD' }, pointer: { x: 12, y: -5, tool: 'pointer' },
      button: 'down', selectedElementIds: { shape: true } });
  });
  it.each([
    { pointer: { x: Infinity, y: 0, tool: 'pointer' } },
    { pointer: { x: 10_000_001, y: 0, tool: 'pointer' } },
    { button: 'invalid' }, { selected: ['x'.repeat(129)] }, { selected: Array(257).fill('x') },
    { selected: { __proto__: true } },
  ])('ignores malformed or oversized presence %j', patch => {
    expect(drawingCollaborators(new Map([[2, { ...state(), drawing: { ...state().drawing, ...patch } }]]), 1, scope).size).toBe(0);
  });
  it('bounds names/colors and skips oversized selections without reading entries', () => {
    expect(drawingCollaborators(new Map([[2, null], [3, undefined]]), 1, scope).size).toBe(0);
    for (const user of [{ name: 'x'.repeat(201), color: '#123456' }, { name: 'X', color: 'url(private)' }]) {
      expect(drawingCollaborators(new Map([[2, { ...state(), user }]]), 1, scope).size).toBe(0);
    }
    const selected = Array(100_000);
    Object.defineProperty(selected, 0, { get() { throw new Error('must not traverse'); } });
    expect(drawingCollaborators(new Map([[2, { ...state(), drawing: { ...state().drawing, selected } }]]), 1, scope).size).toBe(0);
    const oversizedScope = 'x'.repeat(513);
    expect(drawingCollaborators(new Map([[2, { ...state(), drawing: { ...state().drawing, scope: oversizedScope } }]]), 1, oversizedScope).size).toBe(0);
    expect(drawingCollaborators(new Map(Array.from({ length: 300 }, (_, index) => [index + 2, state()])), 1, scope).size).toBe(256);
  });
  it('coalesces and deduplicates, preserves host fields, cancels pending work and removes peers', () => {
    vi.useFakeTimers();
    const local: Record<string, any> = state();
    const states = new Map([[1, local], [2, state()]]);
    let change = () => {};
    const awareness = { clientID: 1, getStates: () => states, getLocalState: () => local,
      setLocalStateField: vi.fn((key, value) => { local[key] = value; change(); }),
      on: vi.fn((_event, handler) => { change = handler; }), off: vi.fn(),
    };
    const api = { updateScene: vi.fn() };
    let valid = true;
    const binding = bindDrawingPresence(awareness as never, api as unknown as ExcalidrawImperativeAPI, scope, () => valid);
    const paints = api.updateScene.mock.calls.length;
    binding.selection({ collaborators: new Map(), selectedElementIds: {}, cursorButton: 'up' } as never);
    expect(api.updateScene.mock.calls.length).toBe(paints + 1);
    expect(api.updateScene.mock.lastCall?.[0].collaborators.size).toBe(1);
    binding.selection({ collaborators: api.updateScene.mock.lastCall?.[0].collaborators, selectedElementIds: {}, cursorButton: 'up' } as never);
    expect(api.updateScene.mock.calls.length).toBe(paints + 1);
    for (let x = 0; x < 100; x++) binding.pointer({ pointer: { x, y: 1 }, button: 'down' } as never);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(local.drawing.pointer.x).toBe(99);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);
    binding.pointer({ pointer: { x: 99, y: 1 }, button: 'down' } as never);
    vi.advanceTimersByTime(50);
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);
    states.delete(2); change();
    expect(api.updateScene.mock.lastCall?.[0].collaborators.size).toBe(0);
    valid = false;
    binding.pointer({ pointer: { x: 100, y: 1 }, button: 'up' } as never);
    vi.advanceTimersByTime(50);
    expect(local.drawing).toBeNull();
    valid = true;
    binding.pointer({ pointer: { x: 200, y: 1 }, button: 'down' } as never);
    const writes = awareness.setLocalStateField.mock.calls.length;
    binding.dispose(); vi.runAllTimers();
    expect(awareness.setLocalStateField).toHaveBeenCalledTimes(writes);
    expect(local.drawing).toBeNull();
    expect(local.cursor).toEqual({ anchor: 'host' });
    expect(local.user).toEqual(state().user);
    expect(awareness.off).toHaveBeenCalled();
  });
});

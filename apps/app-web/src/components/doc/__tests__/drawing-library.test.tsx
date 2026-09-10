// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLibrary, LIBRARY_BYTES, libraryKey, mergeLibraries, officialLibraryUrl, parseLibrary,
  persistLibrary, readLibrary, validateLibraryItems } from '../drawing-library';

const shape = (id: string) => ({ id, type: 'rectangle' as const, x: 0, y: 0, width: 10, height: 10, versionNonce: 1 });
const item = (id: string) => ({ id, status: 'published', created: 1, elements: [shape(id)] });
const items = (id: string) => validateLibraryItems([item(id)]);
const key = libraryKey('https://api.example.com', 'account', 'workspace');
const url = 'https://libraries.excalidraw.com/libraries/example/shapes.excalidrawlib';
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('[COMP:app-web/drawing-library] bounded local library import', () => {
  it('keeps seven missing-ID items stable across sessions and allows deletion/reimport and different content', () => {
    const library = Array.from({ length: 7 }, (_, i) => [{ ...shape(`legacy-${i}`), type: 'draw', points: [[0, 0], [10, 10]] }]);
    const text = JSON.stringify({ type: 'excalidrawlib', version: 1, library });
    const first = parseLibrary(text);
    persistLibrary(key, [], first);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const again = parseLibrary(text);
    expect(again.map(item => item.id)).toEqual(first.map(item => item.id));
    expect(again[0].created).not.toBe(first[0].created);
    expect(again[0].elements[0].type).toBe('line');
    const restored = validateLibraryItems(first.map(item => ({ ...item,
      elements: item.elements.map(element => ({ ...element, versionNonce: 99 })) })));
    persistLibrary(key, first, restored);
    persistLibrary(key, restored, mergeLibraries(restored, again));
    expect(readLibrary(key)).toHaveLength(7);
    persistLibrary(key, restored, restored.slice(1));
    expect(readLibrary(key)).toHaveLength(6);
    persistLibrary(key, readLibrary(key), mergeLibraries(readLibrary(key), parseLibrary(text)));
    expect(readLibrary(key)).toHaveLength(7);
    const different = parseLibrary(JSON.stringify({ type: 'excalidrawlib', version: 1,
      library: [[{ ...library[0][0], width: 20, versionNonce: 99 }]] }));
    expect(different[0].id).not.toBe(first[0].id);
    persistLibrary(key, readLibrary(key), mergeLibraries(readLibrary(key), different));
    expect(readLibrary(key)).toHaveLength(8);
  });
  it('hashes canonical validated content only for missing IDs without secure-context APIs', () => {
    vi.stubGlobal('crypto', undefined);
    const encode = (item: unknown) => JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [item] });
    const element = { ...shape('shape'), roundness: { type: 3, value: 4 } };
    const first = parseLibrary(encode({ name: 'One', elements: [element] }))[0];
    const reordered = Object.fromEntries(Object.entries(element).reverse());
    reordered.roundness = { value: 4, type: 3 };
    expect(parseLibrary(encode({ elements: [reordered], name: 'One', created: 123, status: 'unpublished' }))[0].id).toBe(first.id);
    expect(parseLibrary(encode({ elements: [element], name: 'Two' }))[0].id).not.toBe(first.id);
    expect(parseLibrary(encode({ id: 'explicit-sdk-id', elements: [element] }))[0].id).toBe('explicit-sdk-id');
    expect(() => parseLibrary(encode({ id: '', elements: [element] }))).toThrow();
  });
  it.each(['http://libraries.excalidraw.com/libraries/a.excalidrawlib', 'https://evil.example/libraries/a.excalidrawlib',
    'https://libraries.excalidraw.com.evil.example/libraries/a.excalidrawlib', 'https://user@libraries.excalidraw.com/libraries/a.excalidrawlib',
    'https://libraries.excalidraw.com/libraries/a.svg', 'https://libraries.excalidraw.com/libraries/%2e%2e/a.excalidrawlib',
    'file:///tmp/a.excalidrawlib', 'https://libraries.excalidraw.com/libraries/a.excalidrawlib?redirect=https://evil.example'])('rejects URL %s', raw => {
    expect(() => officialLibraryUrl(raw)).toThrow();
  });
  it('validates geometry/assets/count/bytes and reads legacy libraries', () => {
    expect(parseLibrary(JSON.stringify({ type: 'excalidrawlib', version: 1, library: [[shape('old')]] }))).toHaveLength(1);
    expect(() => validateLibraryItems([{ ...item('bad'), elements: [{ ...shape('bad'), type: 'image' }] }])).toThrow();
    expect(() => validateLibraryItems([{ ...item('bad'), elements: [{ ...shape('bad'), link: 'https://example.com' }] }])).toThrow();
    expect(() => validateLibraryItems([{ ...item('bad'), elements: [{ ...shape('bad'), type: 'line', points: [] }] }])).toThrow();
    expect(() => validateLibraryItems(Array.from({ length: 501 }, (_, i) => item(String(i))))).toThrow();
    expect(() => validateLibraryItems([{ ...item('big'), elements: Array.from({ length: 5001 }, () => shape('a')) }])).toThrow();
    expect(() => parseLibrary(' '.repeat(LIBRARY_BYTES + 1))).toThrow();
    expect(() => parseLibrary('{bad')).toThrow();
  });
  it('merges and deduplicates IDs and content without replacing existing items', () => {
    expect(mergeLibraries(items('a'), validateLibraryItems([{ ...item('a'), elements: [shape('changed')] },
      { ...item('duplicate'), elements: [shape('a')] }, item('b'), item('b')])).map(item => item.id)).toEqual(['a', 'b']);
  });
  it('persists independent updates without erasing unseen items and isolates scopes', () => {
    persistLibrary(key, [], items('a'));
    persistLibrary(key, [], items('b'));
    expect(readLibrary(key).map(item => item.id)).toEqual(['a', 'b']);
    persistLibrary(key, items('a'), []);
    expect(readLibrary(key).map(item => item.id)).toEqual(['b']);
    expect(readLibrary(libraryKey('https://other.example', 'account', 'workspace'))).toEqual([]);
    expect(readLibrary(libraryKey('https://api.example.com', 'other', 'workspace'))).toEqual([]);
    expect(readLibrary(libraryKey('https://api.example.com', 'account', 'other'))).toEqual([]);
  });
  it('preserves stored data on quota failure and refuses malformed storage', () => {
    persistLibrary(key, [], items('a'));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => persistLibrary(key, items('a'), items('b'))).toThrow();
    expect(readLibrary(key)).toEqual(items('a'));
    write.mockRestore(); localStorage.setItem(key, '{bad');
    expect(() => readLibrary(key)).toThrow();
    expect(() => persistLibrary(key, [], items('b'))).toThrow();
    expect(localStorage.getItem(key)).toBe('{bad');
  });
  it('refuses oversized streaming responses and failed HTTP fetches, with no credentials or redirects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(LIBRARY_BYTES + 1)))
      .mockResolvedValueOnce(new Response('', { status: 500 })));
    await expect(fetchLibrary(url, new AbortController().signal)).rejects.toThrow();
    await expect(fetchLibrary(url, new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
  });
});

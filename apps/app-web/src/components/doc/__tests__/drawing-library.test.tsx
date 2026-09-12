// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLibrary, LIBRARY_BYTES, libraryKey, mergeLibraries, officialLibraryUrl, parseLibrary,
  persistLibrary, readLibrary, validateLibraryItems, initializeLibrary } from '../drawing-library';
import { defaultDrawingLibrary } from '../drawing-default-library';

const shape = (id: string) => ({ id, type: 'rectangle' as const, x: 0, y: 0, width: 10, height: 10, versionNonce: 1 });
const item = (id: string) => ({ id, status: 'published', created: 1, elements: [shape(id)] });
const items = (id: string) => validateLibraryItems([item(id)]);
const key = libraryKey('https://api.example.com', 'account', 'workspace');
const url = 'https://libraries.excalidraw.com/libraries/example/shapes.excalidrawlib';
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('[COMP:app-web/drawing-library] bounded local library import', () => {
  it('generates deterministic grouped pixel assets with source metadata within existing limits', async () => {
    const defaults = validateLibraryItems(defaultDrawingLibrary());
    expect(defaults).toHaveLength(38);
    expect(defaultDrawingLibrary()).toEqual(defaults);
    expect(new Set(defaults.map(item => item.id)).size).toBe(38);
    expect(defaults.some(item => item.name === 'use-brian')).toBe(false);
    expect(defaults.every(item => item.elements.every(element => element.type === 'rectangle' &&
      element.groupIds?.[0] === item.id && element.roughness === 0))).toBe(true);
    const engineering = defaults.find(item => item.name === 'brian-intern-engineering-hardhat')!;
    expect(engineering.elements[0].customData).toMatchObject({ discipline: 'engineering', accessory: 'hardhat',
      roles: ['productResearch', 'customerService'] });
    expect(engineering.elements.at(-1)).toMatchObject({ x: 71, y: 81,
      width: 18, height: 18, backgroundColor: '#f97316' });
    const speech = defaults.find(item => item.name === 'brian-intern-media-studies-speech-hi')!;
    expect(speech.elements.at(-1)).toMatchObject({ y: 101, backgroundColor: '#a78bfa' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const { restoreLibraryItems } = await import('@excalidraw/excalidraw');
    const restored = validateLibraryItems(restoreLibraryItems(defaults, 'published'));
    expect(restored.map(item => [item.id, item.name, item.elements.length])).toEqual(defaults.map(item => [item.id, item.name, item.elements.length]));
    expect(restored[0].elements[0].customData).toEqual(defaults[0].elements[0].customData);
  }, 20_000);
  it('seeds once, preserves legacy items and duplicates, and respects partial and full deletion on reopen', () => {
    const defaults = defaultDrawingLibrary();
    const existing = validateLibraryItems([...items('custom'), { ...defaults[0], name: 'My logo' }]);
    localStorage.setItem(key, JSON.stringify(existing));
    const seeded = initializeLibrary(key);
    expect(seeded).toHaveLength(39);
    expect(seeded.slice(0, 2)).toEqual(existing);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(initializeLibrary(key)).toEqual(seeded);
    expect(write).not.toHaveBeenCalled();
    persistLibrary(key, seeded, seeded.slice(2));
    expect(initializeLibrary(key)).toEqual(seeded.slice(2));
    persistLibrary(key, seeded.slice(2), []);
    expect(initializeLibrary(key)).toEqual([]);
    expect(initializeLibrary(`${key}-other`)).toHaveLength(38);
    persistLibrary(key, [], defaults.slice(0, 1));
    expect(initializeLibrary(key)).toEqual(defaults.slice(0, 1));
  });
  it('preserves the bordered logo and intern grids unchanged', () => {
    const defaults = defaultDrawingLibrary();
    expect(defaults).toEqual(defaultDrawingLibrary(2).slice(1));
    expect(defaults).toEqual(defaultDrawingLibrary(3).slice(1));
    for (const item of defaults) {
      for (const [index, element] of item.elements.entries()) {
        if (element.backgroundColor !== '#121e33') continue;
        expect(element).toMatchObject({ width: 20, height: 20 });
        expect(item.elements[index + 1]).toMatchObject({ x: element.x + 1, y: element.y + 1, width: 18, height: 18 });
      }
    }
  });
  it.each([1, 2, 3] as const)('migrates only exact V%s seeds in place, retaining deletions, edits, IDs and order', version => {
    const old = defaultDrawingLibrary(version);
    const current = defaultDrawingLibrary();
    const edited = old.slice(3, 10).map((item, index) => ({ ...item,
      ...(index === 0 ? { name: 'My intern' } : {}),
      ...(index === 1 ? { status: 'unpublished' as const } : {}),
      ...(index === 2 ? { created: 42 } : {}),
      elements: item.elements.map((element, i) => i ? element : { ...element,
        ...(index === 3 ? { x: element.x + 1 } : {}),
        ...(index === 4 ? { backgroundColor: '#ffffff' } : {}),
        ...(index === 5 ? { customData: { note: 'mine' } } : {}),
        ...(index === 6 ? { version: 2 } : {}) }),
    }));
    // Item 2 was deleted; unknown IDs with seed-like metadata are not owned.
    const stored = validateLibraryItems([old[1], ...edited, old[0], ...items('custom'), { ...old[2], id: 'my-copy' }]);
    localStorage.setItem(key, JSON.stringify({ items: stored, defaultsSeeded: true, defaultsVersion: version }));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const migrated = initializeLibrary(key);
    expect(migrated).toEqual([current[0], ...edited, ...stored.slice(9)]);
    expect(migrated.map(item => item.id)).toEqual(stored.filter(item => item.id !== old[0].id).map(item => item.id));
    expect(write).toHaveBeenCalledOnce();
    expect(initializeLibrary(key)).toEqual(migrated);
    expect(write).toHaveBeenCalledOnce();
    // A stale editor notification cannot roll back the repaired stored item.
    persistLibrary(key, stored, stored);
    expect(readLibrary(key)).toEqual(migrated);
    expect(JSON.parse(localStorage.getItem(key)!).defaultsVersion).toBe(4);
    persistLibrary(key, migrated, []);
    expect(initializeLibrary(key)).toEqual([]);
    persistLibrary(key, [], [old[0]]);
    expect(initializeLibrary(key)).toEqual([old[0]]);
  });
  it.each([1, 2, 3] as const)('preserves edited, copied or deleted borderless V%s seeds', version => {
    const old = defaultDrawingLibrary(version)[0];
    const edits = [
      { ...old, id: 'my-copy' }, { ...old, name: 'My logo' },
      { ...old, status: 'unpublished' }, { ...old, created: 42 },
      ...[{ x: 42 }, { backgroundColor: '#ffffff' }, { customData: { note: 'mine' } }, { version: 2 }]
        .map(edit => ({ ...old, elements: old.elements.map((e, i) => i === 1 ? { ...e, ...edit } : e) })),
      { ...old, elements: [...old.elements].reverse() },
    ];
    for (const edited of edits) {
      localStorage.setItem(key, JSON.stringify({ items: [edited], defaultsSeeded: true, defaultsVersion: version }));
      expect(initializeLibrary(key)).toEqual([edited]);
      expect(persistLibrary(key, readLibrary(key), validateLibraryItems([edited]))).toEqual([edited]);
      expect(initializeLibrary(key)).toEqual([edited]);
    }
    localStorage.setItem(key, JSON.stringify({ items: [], defaultsSeeded: true, defaultsVersion: version }));
    expect(initializeLibrary(key)).toEqual([]);
  });
  it('does not resurrect an empty V1 seeded library and leaves old storage intact on migration failure', () => {
    localStorage.setItem(key, JSON.stringify({ items: [], defaultsSeeded: true }));
    expect(initializeLibrary(key)).toEqual([]);
    const original = JSON.stringify({ items: defaultDrawingLibrary(1), defaultsSeeded: true });
    localStorage.setItem(key, original);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => initializeLibrary(key)).toThrow();
    expect(localStorage.getItem(key)).toBe(original);
  });
  it.each(['bytes', 'elements', 'items'])('keeps a valid library available when defaults exceed %s capacity, then retries after space is freed', limit => {
    const existing = validateLibraryItems(limit === 'bytes'
      ? [{ ...item('large'), elements: [{ ...shape('large'), customData: { padding: 'x'.repeat(LIBRARY_BYTES - 1024) } }] }]
      : limit === 'elements'
        ? [{ ...item('large'), elements: Array.from({ length: 4990 }, (_, i) => shape(`shape-${i}`)) }]
        : Array.from({ length: 499 }, (_, i) => item(`item-${i}`)));
    const original = JSON.stringify(existing);
    localStorage.setItem(key, original);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(() => mergeLibraries(existing, defaultDrawingLibrary())).toThrow('library-size');
    expect(initializeLibrary(key)).toEqual(existing);
    expect(initializeLibrary(key)).toEqual(existing);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(original);
    persistLibrary(key, existing, items('kept'));
    expect(readLibrary(key)).toEqual(items('kept'));
    expect(initializeLibrary(key)).toHaveLength(39);
    expect(readLibrary(key)[0]).toEqual(items('kept')[0]);
    expect(JSON.parse(localStorage.getItem(key)!).defaultsSeeded).toBe(true);
  });
  it('does not destroy legacy storage or mark defaults seeded when initialization fails', () => {
    localStorage.setItem(key, JSON.stringify(items('custom')));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => initializeLibrary(key)).toThrow();
    expect(readLibrary(key)).toEqual(items('custom'));
    write.mockRestore();
    expect(initializeLibrary(key)).toHaveLength(39);
    localStorage.setItem(key, '{bad');
    expect(() => initializeLibrary(key)).toThrow();
    expect(localStorage.getItem(key)).toBe('{bad');
  });
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

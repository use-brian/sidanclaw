import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { drawingSceneSchema, drawingLibraryIndexSchema, drawingLibraryPreviewPathSchema } from '@use-brian/shared/drawing';

export const LIBRARY_BYTES = 2 * 1024 * 1024;
export function isLocalLibraryOrigin(href: string) {
  const { protocol, hostname } = new URL(href);
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return protocol === 'http:' || host === 'localhost' || !host.includes('.') && !host.includes(':') ||
    /\.(localhost|local|internal|lan|home)$/.test(host) ||
    /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^\[::ffff:/.test(host) || /^\[(::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\]$/.test(host);
}
export type LibraryTarget = { key: string; account: string; path: string; block: string };
export function libraryKey(api: string, account: string, workspace: string) {
  return `brian:drawing-library:v1:${JSON.stringify([api, account, workspace])}`;
}
export function officialLibraryUrl(raw: string) {
  if (raw.length > 2048) throw new Error('library-url');
  const url = new URL(raw);
  if (url.origin !== 'https://libraries.excalidraw.com' || url.username || url.password ||
    !/^\/libraries\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.excalidrawlib$/.test(url.pathname) || url.hash || url.search) {
    throw new Error('library-url');
  }
  return url.href;
}
export function validateLibraryItems(value: unknown): LibraryItems {
  if (!Array.isArray(value) || value.length > 500 || new TextEncoder().encode(JSON.stringify(value)).length > LIBRARY_BYTES) throw new Error('library-size');
  let count = 0;
  const items = value.map((item: Record<string, unknown>) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
      !['published', 'unpublished'].includes(String(item.status)) || typeof item.created !== 'number' || !Number.isFinite(item.created) ||
      (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 200)) ||
      !Array.isArray(item.elements) || !item.elements.length) throw new Error('library-data');
    count += item.elements.length;
    if (count > 5000 || item.elements.some(element => element?.type === 'image' || element?.isDeleted === true)) throw new Error('library-assets');
    const scene = drawingSceneSchema.parse({ version: 1, elements: item.elements, appState: { viewBackgroundColor: '#fff' }, files: {} });
    return { id: item.id, status: item.status, created: item.created, elements: scene.elements,
      ...(item.name !== undefined ? { name: item.name } : {}) };
  });
  return items as unknown as LibraryItems;
}
function libraryItemContent(item: LibraryItems[number]) {
  return JSON.stringify({ elements: item.elements, name: item.name }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export function parseLibrary(text: string): LibraryItems {
  if (new TextEncoder().encode(text).length > LIBRARY_BYTES) throw new Error('library-size');
  const data = JSON.parse(text);
  if (data?.type !== 'excalidrawlib' || ![1, 2].includes(data.version)) throw new Error('library-data');
  const source = data.version === 1 ? data.library : data.libraryItems;
  if (!Array.isArray(source)) throw new Error('library-data');
  if (!source.length) throw new Error('library-empty');
  const items = source.map(value => {
    const item = data.version === 1 ? { elements: value } : value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('library-data');
    // Excalidraw's legacy pencil strokes restore as lines, not modern freedraw.
    // Normalize only the type; geometry and unsafe fields still pass validation.
    const elements = Array.isArray(item.elements) ? item.elements.map((element: unknown) =>
      element && typeof element === 'object' && 'type' in element && element.type === 'draw' ?
        { ...element, type: 'line' } : element) : item.elements;
    return { ...item, elements, id: item.id ?? `brian-library-v1-${'0'.repeat(32)}`, status: item.status ?? 'published', created: item.created ?? Date.now() };
  });
  return validateLibraryItems(items).map((item, index) => {
    if (data.version !== 1 && source[index].id != null) return item;
    // FNV-1a 128 is a portable content identity, never a security nonce.
    // Hash before SDK restoration generates volatile legacy element defaults.
    let hash = BigInt('0x6c62272e07bb014262b821756295c58d');
    const prime = BigInt('0x1000000000000000000013b');
    for (const byte of new TextEncoder().encode(libraryItemContent(item))) {
      hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * prime);
    }
    return { ...item, id: `brian-library-v1-${hash.toString(16).padStart(32, '0')}` };
  });
}
export function mergeLibraries(existing: LibraryItems, incoming: LibraryItems): LibraryItems {
  const merged = [...existing];
  const signature = libraryItemContent;
  const ids = new Set(existing.map(item => item.id));
  const signatures = new Set(existing.map(signature));
  for (const item of incoming) {
    if (!ids.has(item.id) && !signatures.has(signature(item))) {
      merged.push(item); ids.add(item.id); signatures.add(signature(item));
    }
  }
  return validateLibraryItems(merged);
}
export function readLibrary(key: string): LibraryItems {
  const text = localStorage.getItem(key);
  if (!text) return [];
  if (text.length > LIBRARY_BYTES) throw new Error('library-size');
  return validateLibraryItems(JSON.parse(text));
}
export function persistLibrary(key: string, previous: LibraryItems, next: LibraryItems) {
  const validated = validateLibraryItems(next);
  const removed = new Set(previous.filter(item => !validated.some(next => next.id === item.id)).map(item => item.id));
  const merged = mergeLibraries(readLibrary(key).filter(item => !removed.has(item.id)), validated);
  localStorage.setItem(key, JSON.stringify(merged));
  return merged;
}
export async function fetchLibrary(raw: string, signal: AbortSignal) {
  return parseLibrary(await fetchLibraryText(officialLibraryUrl(raw), signal));
}
export async function fetchLibraryIndex(signal: AbortSignal) {
  const entries = drawingLibraryIndexSchema.parse(JSON.parse(await fetchLibraryText('https://libraries.excalidraw.com/libraries.json', signal)));
  return [...new Map(entries.map(entry => {
    const url = officialLibraryUrl(`https://libraries.excalidraw.com/libraries/${entry.source}`);
    return [url, { name: entry.name, authors: entry.authors.map(author => author.name).join(', '), url,
      preview: entry.preview ? officialLibraryPreviewUrl(entry.preview) : undefined }];
  })).values()];
}
export function officialLibraryPreviewUrl(path: string) {
  return new URL(drawingLibraryPreviewPathSchema.parse(path), 'https://libraries.excalidraw.com/libraries/').href;
}
async function fetchLibraryText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIBRARY_BYTES) throw new Error('library-fetch');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIBRARY_BYTES) throw new Error('library-size');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

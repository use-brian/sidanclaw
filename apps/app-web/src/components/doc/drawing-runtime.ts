// Set this BEFORE evaluating Excalidraw: font URLs are created at module load.
export function loadDrawingRuntime() {
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL(
    window.location.protocol === 'file:' ? './excalidraw/' : '/excalidraw/',
    document.baseURI,
  ).href;
  return import('@excalidraw/excalidraw');
}

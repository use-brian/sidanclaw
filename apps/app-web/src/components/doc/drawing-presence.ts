import { drawingPresenceSchema as presenceSchema, drawingPresenceUserSchema as userSchema, type DrawingPresence as Presence } from '@use-brian/shared/drawing';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types';

type Awareness = NonNullable<HocuspocusProvider['awareness']>;

export function drawingCollaborators(states: Map<number, unknown>, self: number, scope: string): AppState['collaborators'] {
  const result: AppState['collaborators'] = new Map();
  for (const [client, state] of states) {
    if (client === self || result.size >= 256 || !state || typeof state !== 'object') continue;
    const fields = state as Record<string, unknown>;
    const raw = fields.drawing as Partial<Presence> | null | undefined;
    // Check the array budget before Zod traverses attacker-controlled entries.
    if (!raw || raw.scope !== scope || !Array.isArray(raw.selected) || raw.selected.length > 256) continue;
    const presence = presenceSchema.safeParse(raw), user = userSchema.safeParse(fields.user);
    if (!presence.success || !user.success) continue;
    const socketId = String(client) as Parameters<AppState['collaborators']['set']>[0];
    result.set(socketId, { socketId, username: user.data.name,
      color: { background: user.data.color, stroke: user.data.color },
      ...(presence.data.pointer ? { pointer: presence.data.pointer } : {}),
      button: presence.data.button,
      selectedElementIds: Object.fromEntries(presence.data.selected.map(key => [key, true])),
    });
  }
  return result;
}

/** Own only the drawing awareness field, never the page's user/cursor state. */
export function bindDrawingPresence(awareness: Awareness, api: ExcalidrawImperativeAPI, scope: string, valid: () => boolean) {
  let pending: Presence = { scope, pointer: null, button: 'up', selected: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = '', rendered = '', disposed = false;
  const render = () => {
    if (disposed) return;
    const collaborators = valid() ? drawingCollaborators(awareness.getStates(), awareness.clientID, scope) : new Map();
    const signature = JSON.stringify([...collaborators]);
    if (signature === rendered) return;
    rendered = signature;
    api.updateScene({ collaborators });
  };
  const flush = () => {
    timer = undefined;
    if (disposed) return;
    const value = valid() ? presenceSchema.safeParse(pending) : null;
    const next = value?.success ? value.data : null;
    const signature = JSON.stringify(next);
    if (signature === sent) return;
    sent = signature;
    awareness.setLocalStateField('drawing', next);
  };
  const schedule = () => { if (!disposed && timer === undefined) timer = setTimeout(flush, 50); };
  awareness.on('change', render);
  flush(); render();
  return {
    pointer(payload: Parameters<NonNullable<ExcalidrawProps['onPointerUpdate']>>[0]) {
      pending = { ...pending, pointer: { x: payload.pointer.x, y: payload.pointer.y, tool: 'pointer' }, button: payload.button };
      schedule();
    },
    selection(state: AppState) {
      // SDK initialization can reset collaborators after the first awareness
      // paint. Repair from current awareness even if no peer has moved since.
      if (JSON.stringify([...state.collaborators]) !== rendered) { rendered = ''; render(); }
      const selected = new Set(Object.keys(state.selectedElementIds).filter(key => state.selectedElementIds[key]));
      for (const element of [state.editingTextElement, state.newElement, state.resizingElement]) if (element) selected.add(element.id);
      pending = { ...pending, selected: [...selected].slice(0, 256), button: state.cursorButton };
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      awareness.off('change', render);
      if (awareness.getLocalState()?.drawing?.scope === scope) awareness.setLocalStateField('drawing', null);
      api.updateScene({ collaborators: new Map() });
    },
  };
}

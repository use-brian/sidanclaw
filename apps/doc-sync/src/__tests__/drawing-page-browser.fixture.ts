// One ESM graph for the browser runner's server, JWT endpoint and protocol gate.
export { Server } from '@hocuspocus/server';
export * as Y from 'yjs';
export { resolveAuth } from '../auth-hook.js';
export { assertDrawingProtocol } from '../drawing-protocol.js';
export { localSessionRoutes } from '../../../../packages/api/src/routes/local-session.js';

# Page Drawings

Excalidraw drawings are an OSS Page feature, not an Office document feature.
The slash menu offers Drawing (aliases: draw, sketch, excalidraw). The inserted
empty embed offers an explicit editor button. Save commits one complete scene;
Cancel discards the local draft without changing the block. Existing drawings
show a scene-derived canvas preview and can be reopened for editing.

## Persistence and Authority

`drawing` is a member of the canonical core Block/schema union. Its versioned
scene contains elements, a small durable app-state subset, and embedded raster
files. No preview is authoritative or persisted. The existing embed JSON attr,
ProseMirror transactions, Yjs encoding, server snapshots, and Page add/edit/delete
operations carry the same block. Brian can read and replace scenes with those
existing selection/block-ID scoped operations; no human-only storage or new tool
is introduced. Ordinary page authorization remains authoritative on the server.

Save checks current editor authority and the original node's identity/content
immediately before dispatch. A remotely changed or deleted block rejects the
save rather than replacing another block. This is optimistic protection, not
scene-level multi-user merging: simultaneous offline saves remain Yjs last-writer
wins. Drawing gestures and Undo stay local until Save; Cancel never writes.

## Safety and Delivery

Scenes are limited to 2 MiB serialized UTF-8 and 5,000 elements. Image assets
must be inline base64 PNG/JPEG/WebP/GIF; remote URLs and SVG assets are rejected.
Every live image must have its file. Unsupported or oversized scenes fail visibly,
never silently dropping images. Preview is exported to canvas, never injected SVG.
Save filters Excalidraw's retained file map to live image references before
validation; deleting an unsupported or oversized image therefore allows saving
again without accumulating unused assets. Linear elements require at least two
finite coordinate pairs; freehand elements require points and pressure settings,
with matching pressure samples when pressure is not simulated. Text requires
text/font metrics. Optional binding, crop, scale, and elbow-segment geometry is
validated when present before Excalidraw restoration.
Editor code loads client-side on demand; bundled fonts are served locally in both
Next and desktop builds. The dialog uses the app theme, en/ja/zh translations,
focus trapping, responsive sizing, and explicit Save/Cancel controls.

## Integration Constraints

Deploy the shared/core schema and UI together. No database migration is required.
Markdown/Office exports are not editable Excalidraw interchange; the canonical
Page JSON is the lossless interchange. The platform lockfile and external docs
mirrors are outside this worktree's scope and must be integrated separately.

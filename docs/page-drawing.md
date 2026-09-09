# Page Drawings

Excalidraw drawings are an OSS Page feature, not an Office document feature.
The slash menu offers Drawing (aliases: draw, sketch, excalidraw). The inserted
empty embed offers an explicit editor button. Save commits one complete scene;
Cancel discards the local draft without changing the block. Existing drawings
show a scene-derived canvas preview and can be reopened for editing.

## Persistence and Authority

`drawing` is a member of the canonical core Block/schema union. Its versioned
scene contains elements, a small durable app-state subset, and embedded raster
files. An optional derived PNG preview is persisted alongside the scene, never
as its authority. Browser Save exports a light-mode PNG using the scene's
background (at most 1600 px per side and 1 MiB of PNG file bytes), bound to the canonical
scene by SHA-256. Empty
scenes save without a preview. Export failures leave the draft open without
committing. The existing embed JSON attr, ProseMirror transactions, Yjs encoding,
server snapshots, and Page add/edit/delete
operations carry the same block. Brian can read and replace scenes with those
existing selection/block-ID scoped operations; no human-only storage or new tool
is introduced. Ordinary page authorization remains authoritative on the server.

Brian's targeted `getBlock` read delivers a valid export as actual model image
content through the existing tool-result image channel, for both the parent
assistant and delegated document editor. Bulk reads do not attach images. Tool
text excludes preview bytes and embedded raster bytes; file metadata remains.
Do not reconstruct omitted file bytes when editing. Missing, invalid, or
scene-mismatched exports are explicitly unavailable, not evidence of the drawing.
Before declaring an export available, the server checks all chunk lengths and
CRCs, bounds IDAT inflation by the validated image dimensions, and fully decodes
and re-encodes the pixels with the existing image decoder. Ancillary metadata is
not decompressed or forwarded. Invalid PNGs leave the canonical scene readable
but the preview unavailable. The regenerated PNG must also fit the 1 MiB cap.
The pixel limit is 2,560,000; the IDAT inflate cap is derived from dimensions
and never exceeds 20,492,800 bytes (16-bit RGBA plus interlace filter overhead).
Bulk block arrays are decoded serially rather than allocating for every drawing
concurrently.
AI scene edits invalidate the previous preview. New AI drawings and older scenes
need a browser editor Save before visual reading; there is no server-side renderer,
background mutation from read-only rendering, or remote image fetching.
Text-only providers cannot visually read the attachment. Each targeted read adds
at most one image; ordinary text-result truncation does not truncate image bytes.
The existing executor caps tool text at 25,000 estimated tokens; scene geometry
can still be truncated at that limit. Context fitting currently estimates 1,000
tokens per image (actual provider usage varies) and may evict old messages. A
fresh targeted read restores the visual evidence when needed.

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

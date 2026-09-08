import { z } from 'zod'

export const MAX_DRAWING_BYTES = 2 * 1024 * 1024

// Preserve versioned element fields; refuse executable embeds and remote files.
const pointSchema = z.tuple([z.number().finite(), z.number().finite()])
const bindingSchema = z.object({
  elementId: z.string(), focus: z.number().finite(), gap: z.number().finite(),
  fixedPoint: pointSchema.optional(),
}).passthrough().nullable().optional()
const elementBaseSchema = z.object({
  id: z.string().min(1),
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite(), height: z.number().finite(),
  isDeleted: z.boolean().optional(),
  fileId: z.string().nullable().optional(),
  link: z.null().optional(),
  groupIds: z.array(z.string()).optional(),
  boundElementIds: z.array(z.string()).optional(),
  boundElements: z.array(z.object({ id: z.string(), type: z.enum(['arrow', 'text']) }).passthrough()).nullable().optional(),
}).passthrough()

const linearSchema = elementBaseSchema.extend({
  points: z.array(pointSchema).min(2),
  startBinding: bindingSchema, endBinding: bindingSchema,
})

// restoreElements checks points before applying defaults. Freehand pressure
// data and text/font metrics are also consumed without usable defaults in 0.18.
const elementSchema = z.discriminatedUnion('type', [
  elementBaseSchema.extend({ type: z.literal('rectangle') }),
  elementBaseSchema.extend({ type: z.literal('diamond') }),
  elementBaseSchema.extend({ type: z.literal('ellipse') }),
  elementBaseSchema.extend({ type: z.literal('frame'), name: z.string().nullable().optional() }),
  linearSchema.extend({ type: z.literal('line') }),
  linearSchema.extend({
    type: z.literal('arrow'), elbowed: z.boolean().optional(),
    fixedSegments: z.array(z.object({ start: pointSchema, end: pointSchema, index: z.number().int().nonnegative() }).passthrough()).nullable().optional(),
  }),
  elementBaseSchema.extend({
    type: z.literal('freedraw'), points: z.array(pointSchema).min(1),
    simulatePressure: z.boolean(), pressures: z.array(z.number().finite().min(0).max(1)),
  }),
  elementBaseSchema.extend({
    type: z.literal('text'), text: z.string(), fontSize: z.number().finite().positive(),
    fontFamily: z.number().int().positive(), lineHeight: z.number().finite().positive().optional(),
    // Legacy `font` overrides the numeric metrics during restoration.
    font: z.never().optional(), originalText: z.string().optional(),
  }),
  elementBaseSchema.extend({
    type: z.literal('image'), scale: pointSchema.optional(),
    crop: z.object({
      x: z.number().finite(), y: z.number().finite(),
      width: z.number().finite().positive(), height: z.number().finite().positive(),
      naturalWidth: z.number().finite().positive(), naturalHeight: z.number().finite().positive(),
    }).passthrough().nullable().optional(),
  }),
]).superRefine((element, ctx) => {
  if (element.type === 'freedraw' && !element.simulatePressure && element.pressures.length !== element.points.length) {
    ctx.addIssue({ code: 'custom', path: ['pressures'], message: 'Freehand pressure samples must match points' })
  }
})

export const drawingSceneSchema = z.object({
  version: z.literal(1),
  elements: z.array(elementSchema).max(5000),
  appState: z.object({ viewBackgroundColor: z.string().max(64) }).strict(),
  files: z.record(z.object({
    id: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    dataURL: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
    created: z.number().finite(),
    lastRetrieved: z.number().finite().optional(),
    version: z.number().finite().optional(),
  }).strict()),
}).strict().superRefine((scene, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(scene)).length > MAX_DRAWING_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Drawing exceeds 2 MiB' })
  }
  for (const element of scene.elements) {
    if (element.type === 'image' && !element.isDeleted &&
      (!element.fileId || !scene.files[element.fileId])) {
      ctx.addIssue({ code: 'custom', message: 'Drawing image file is missing' })
    }
  }
  for (const [id, file] of Object.entries(scene.files)) {
    if (file.id !== id || !file.dataURL.startsWith(`data:${file.mimeType};base64,`)) {
      ctx.addIssue({ code: 'custom', message: 'Drawing image metadata mismatch' })
    }
  }
})

export const drawingBlockSchema = z.object({
  kind: z.literal('drawing'),
  id: z.string().min(1).max(128),
  scene: drawingSceneSchema,
})
export type DrawingScene = z.infer<typeof drawingSceneSchema>
export type DrawingBlock = z.infer<typeof drawingBlockSchema>

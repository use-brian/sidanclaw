/** Bounded CRM collection contract shared by read ports and adapters.
 * [COMP:crm/operations-pagination]
 */
import { z } from 'zod'

export const CrmPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
}).strict()
export type CrmPageQuery = Partial<z.infer<typeof CrmPageQuerySchema>>
export type CrmPage<Key extends string, Item = Record<string, unknown>> = Record<Key, Item[]> & { nextCursor: string | null }

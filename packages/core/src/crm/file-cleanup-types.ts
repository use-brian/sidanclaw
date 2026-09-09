/** Review and receipt for staged CRM source bytes. [COMP:crm/file-cleanup] */
import {z} from 'zod'
import type {CrmOperationsContext,CrmPrivacyBlocker,CrmPrivacyDomainReview} from './operations-types.js'

export const PreviewCrmImportFileCleanupCommandSchema=z.object({
  kind:z.literal('preview_import_file_cleanup'),fileId:z.string().uuid().transform(value=>value.toLowerCase()),before:z.string().datetime({offset:true}),
}).strict()
export const ExecuteCrmImportFileCleanupCommandSchema=z.object({
  kind:z.literal('execute_import_file_cleanup'),previewId:z.string().uuid(),previewHash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),
}).strict()
export type CrmImportFileCleanupPreview={
  id:string;fileId:string;previewHash:string;expiresAt:string;policyVersion:number;
  domains:CrmPrivacyDomainReview[];blockers:CrmPrivacyBlocker[];status:'ready'|'blocked';scope:'crm_import_source_file'
}
export interface CrmImportFileCleanupPort {
  preview(context:CrmOperationsContext,command:z.infer<typeof PreviewCrmImportFileCleanupCommandSchema>):Promise<CrmImportFileCleanupPreview>
  execute(context:CrmOperationsContext,command:z.infer<typeof ExecuteCrmImportFileCleanupCommandSchema>):Promise<{receipt:Record<string,unknown>;duplicate:boolean}>
  read(context:CrmOperationsContext,id:string):Promise<Record<string,unknown>>
}

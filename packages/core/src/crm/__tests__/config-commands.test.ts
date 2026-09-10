import { describe, expect, it } from 'vitest'
import { CrmConfigCommandSchema } from '../config-commands.js'
import { CRM_CUSTOM_FIELD_TYPES } from '../types.js'
import { CrmOperationsCommandSchema, assertCrmOperationsAuthority, type CrmOperationsContext } from '../operations-types.js'

const id = '11111111-1111-4111-8111-111111111111'
describe('[COMP:crm/config-commands] Canonical configuration schemas', () => {
  it('uses the custom-field catalog, validates select/reference options and preserves command defaults', () => {
    const field = { kind: 'create_record_field', entityKind: 'person', fieldKey: 'tier', label: 'Tier' }
    for (const fieldType of CRM_CUSTOM_FIELD_TYPES) {
      const options = fieldType === 'entity_reference' ? ['company'] : ['single_select', 'multi_select'].includes(fieldType) ? ['Standard'] : []
      expect(CrmOperationsCommandSchema.parse({ ...field, fieldType, options })).toMatchObject({ ...field, fieldType, options, isRequired: false })
    }
    for (const extra of [{ fieldType: 'string_array' }, { fieldType: 'single_select', options: [] },
      { fieldType: 'entity_reference', options: ['project'] }, { fieldType: 'multi_select', options: ['A', 'A'] }]) {
      expect(CrmConfigCommandSchema.safeParse({ ...field, ...extra }).success).toBe(false)
    }
    expect(CrmConfigCommandSchema.parse({ kind: 'create_pipeline', name: 'Pipeline' })).toMatchObject({ isDefault: false })
    expect(CrmConfigCommandSchema.parse({ kind: 'create_pipeline_stage', pipelineId: id, name: 'Stage', category: 'open', probability: 25 }))
      .toMatchObject({ requiredFields: [] })
  })
  it('accepts metadata-only patches without defaults that overwrite omitted fields and refuses identity/authority changes', () => {
    expect(CrmConfigCommandSchema.parse({ kind: 'update_pipeline_stage', stageId: id, name: 'Updated' }))
      .toEqual({ kind: 'update_pipeline_stage', stageId: id, name: 'Updated' })
    for (const extra of [{ fieldKey: 'other' }, { fieldType: 'number' }, { entityKind: 'deal' }, { actor: { kind: 'user', userId: id } }, { workspaceId: id }]) {
      expect(CrmConfigCommandSchema.safeParse({ kind: 'update_record_field', fieldId: id, label: 'Updated', ...extra }).success).toBe(false)
    }
  })
  it('does not derive configuration authority from CRM write permission alone', () => {
    const command = CrmOperationsCommandSchema.parse({ kind: 'create_pipeline', name: 'Pipeline' })
    const member: CrmOperationsContext = { workspaceId: id, actor: { kind: 'user', userId: id },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] } }
    expect(() => assertCrmOperationsAuthority(member, command)).toThrow('owner or admin')
    expect(() => assertCrmOperationsAuthority({ ...member, authority: { ...member.authority, role: 'owner', canConfigure: true } }, command)).not.toThrow()
  })
})

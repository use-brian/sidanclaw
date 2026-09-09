/** System-only context shared by every provider, never a user-message prefix. */
export type SystemContext = {
  systemPrompt: string
  runtimeSystemContext?: string
}

/** Preserve the stable bytes; wrap runtime addenda without changing provenance. */
export function systemContextParts(context: SystemContext): string[] {
  const parts = context.systemPrompt ? [context.systemPrompt] : []
  if (context.runtimeSystemContext?.trim()) {
    parts.push(`<runtime_context>\n${context.runtimeSystemContext}\n</runtime_context>`)
  }
  return parts
}

/** For single-string transports and complete prompt accounting/diagnostics. */
export function renderSystemContext(context: SystemContext): string {
  return systemContextParts(context).join('\n\n')
}

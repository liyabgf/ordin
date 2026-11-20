type Risk = 'read' | 'reply' | 'write' | 'control'

// Paths follow the existing execution boundaries. A registration does not authorize access to an object.
const registry = {
  coordinator: {
    asset_search: 'read', asset_get: 'read', asset_read_sample: 'read', asset_revisions: 'read', asset_relations: 'read',
    attach_asset_to_task: 'write', inspect_runtime: 'read', reply: 'reply', clarify: 'reply',
    skill_search: 'read', skill_get: 'read', memory_search: 'read', get_task_status: 'read', list_my_tasks: 'read',
    recipe_list: 'read', recipe_get: 'read',
    create_task: 'write', add_task_input: 'write', cancel_or_pause_task: 'control', propose_memory: 'write',
  },
  desk: {
    ordin_create_ticket: 'write', ordin_list_tickets: 'read', ordin_recall: 'read', ordin_ticket_status: 'read',
    ordin_answer_ticket: 'write', ordin_reply: 'reply', ordin_raise_decision: 'write', ordin_note_ticket: 'write',
    ordin_stop_ticket: 'control', ordin_close_ticket: 'control', ordin_retry_ticket: 'control',
  },
  worker: {
    ordin_report: 'write', ordin_read_artifact: 'read', ordin_ask_desk: 'reply', ordin_handback: 'control',
    ordin_raise_decision: 'write', ordin_note_ticket: 'write',
  },
} as const satisfies Record<string, Record<string, Risk>>

export type ToolPath = keyof typeof registry

export function toolRisk(path: ToolPath, name: string): Risk | undefined {
  const entries: Readonly<Record<string, Risk>> = registry[path]
  return Object.hasOwn(entries, name) ? entries[name] : undefined
}

/** Bind existing schemas/handlers to their path. A missing, duplicate, or misplaced definition fails loudly. */
export function bindToolPath<T extends { readonly name: string }>(path: ToolPath, definitions: readonly T[]): T[] {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (!toolRisk(path, definition.name) || seen.has(definition.name)) throw new Error('Invalid tool binding for ' + path + ': ' + definition.name)
    seen.add(definition.name)
  }
  for (const name of Object.keys(registry[path])) {
    if (!seen.has(name)) throw new Error('Missing tool binding for ' + path + ': ' + name)
  }
  return [...definitions]
}

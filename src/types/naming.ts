/** 命名迁移映射：wp-0.1 合同的唯一代码事实源。 */

/** M1 工具名迁移：旧 ordin_* → 新ordin_*。 */
export const TOOL_NAME_MAP = {
  ordin_report: 'ordin_report',
  ordin_read_artifact: 'ordin_read_artifact',
  ordin_ask_desk: 'ordin_ask_desk',
  ordin_handback: 'ordin_handback',
  ordin_raise_decision: 'ordin_raise_decision',
  ordin_note_ticket: 'ordin_note_ticket',
  ordin_create_ticket: 'ordin_create_ticket',
  ordin_list_tickets: 'ordin_list_tickets',
  ordin_recall: 'ordin_recall',
  ordin_ticket_status: 'ordin_ticket_status',
  ordin_answer_ticket: 'ordin_answer_ticket',
  ordin_reply: 'ordin_reply',
  ordin_stop_ticket: 'ordin_stop_ticket',
  ordin_close_ticket: 'ordin_close_ticket',
  ordin_retry_ticket: 'ordin_retry_ticket',
} as const satisfies Record<string, string>

/** M1 技能名前缀迁移。 */
export const SKILL_PREFIX_OLD = 'ordin-' as const
export const SKILL_PREFIX_NEW = 'ordin-' as const

/** M1 存储迁移。 */
export const LOCK_FILE_OLD = 'ordin.lock' as const
export const LOCK_FILE_NEW = 'ordin.lock' as const
export const MARKER_FILE_OLD = 'ordin.json' as const
export const MARKER_FILE_NEW = 'ordin.json' as const

/** 兼容读取：旧工具名→新名；已经是新名则原样返回。 */
export function mapLegacyToolName(name: string): string {
  return (TOOL_NAME_MAP as Record<string, string>)[name] ?? name
}

/** 兼容读取：旧技能名→新名；已经是新名则原样返回。 */
export function mapLegacySkillName(name: string): string {
  return name.startsWith(SKILL_PREFIX_OLD) ? SKILL_PREFIX_NEW + name.slice(SKILL_PREFIX_OLD.length) : name
}

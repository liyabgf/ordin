import { createHash } from 'node:crypto'

// Repository-reviewed pilot procedures, separate from Worker skills and panel templates.
const pilotRecipes = [
  {
    id: 'compare-assets', revision: 1, enabled: true,
    title: '查找并比较资产',
    appliesWhen: '用户希望查找、核对或比较目录中的资料或版本。',
    requiredTools: ['asset_search', 'asset_get', 'asset_revisions', 'asset_read_sample'],
    steps: [
      '用资产名称或其它目录线索搜索。对象不唯一且结果不足以消除歧义时，向用户澄清。',
      '检查目标详情和版本。仅对需要核对正文的授权固定版本读取样本。',
      '按资产 ID、版本和哈希引用对比证据，明确指出样本截断或只能读取元数据的情况。',
    ],
    evidence: '目录、固定版本引用以及实际返回的正文样本。',
    verify: '对比结论能对应到具体版本和已获得的证据。',
    onFailure: '缺少可访问版本或正文时，报告可核实的范围和缺失部分。',
  },
  {
    id: 'attach-task-materials', revision: 1, enabled: true,
    title: '给现有任务补材料',
    appliesWhen: '用户希望给原对话里的一个指定任务追加固定版本资料。',
    requiredTools: ['get_task_status', 'asset_get', 'attach_asset_to_task'],
    steps: [
      '核对指定任务和所选资产版本。目标不明确时先澄清。',
      '以本轮工具是否开放为准。未开放时提示在原对话中选版本并明确发送附加命令。',
      '授权成立时调用附加工具，记录任务、引用和实际回执。',
    ],
    evidence: '任务状态、固定资产引用和持久化投递回执。',
    verify: '回执匹配所选固定版本，正确区分待投递、已送达和未送达。',
    onFailure: '任务归属、状态或资产版本不符时，说明失败项，等待用户修正。',
  },
  {
    id: 'diagnose-execution', revision: 1, enabled: true,
    title: '诊断任务执行失败',
    appliesWhen: '用户希望定位某个任务的执行失败，或者确认当前执行端的检查证据。',
    requiredTools: ['get_task_status', 'inspect_runtime'],
    steps: [
      '针对有明确 ID 的任务读取持久状态、报告及近期阶段。',
      '读取当前所选执行端的配置、缓存探测时间和近期任务回执。',
      '核对任务实际使用的执行端。按来源分别报告任务事实和当前执行端证据。',
    ],
    evidence: '任务状态及报告、所选执行端配置和进程内探测时间、近期任务回执。',
    verify: '事实可追到工具回执，明确指出未知、过期或执行端不一致。',
    onFailure: '证据不足时说明未知项，并指出可由用户复查的设置或任务。',
  },
] as const

const catalog = pilotRecipes.map(recipe => ({
  ...recipe,
  contentHash: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'),
}))

export function listManagerRecipes() {
  return catalog.filter(recipe => recipe.enabled).map(({ id, revision, contentHash, enabled, title, appliesWhen }) =>
    ({ id, revision, contentHash, enabled, title, appliesWhen }))
}

export function getManagerRecipe(id: string, revision: number, contentHash: string) {
  const recipe = catalog.find(entry => entry.enabled && entry.id === id)
  if (!recipe) throw new Error('Recipe is unavailable')
  if (recipe.revision !== revision || recipe.contentHash !== contentHash) throw new Error('Recipe version changed; list recipes again')
  return recipe
}

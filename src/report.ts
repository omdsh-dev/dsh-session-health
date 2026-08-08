/**
 * 健康报告生成 —— 帧级诊断结果 → 报告 JSON + suggestions 模板。
 * 只读诊断：不修改/删除任何文件。
 */

export type IssueCode =
  | 'missing' | 'not-zstd' | 'empty' | 'torn'
  | 'reserved-header' | 'reserved-block'
  | 'bad-header' | 'empty-session' | 'oversized-single-frame'
  | 'interrupted' | 'stray-file'

/** 单文件诊断。 */
export interface FileDiagnosis {
  id: string
  path: string
  bytes: number
  frames: number | null
  /** 帧数 - 1 ≈ 事件批次下限（估算，非精确事件数）。 */
  estimatedEventBatches: number | null
  issues: IssueCode[]
}

export interface HealthReport {
  root: string
  scanned: number
  errors: Partial<Record<IssueCode, number>>
  suspicious: Partial<Record<IssueCode, number>>
  totals: { bytes: number; frames: number; estimatedEventBatches: number }
  detail: FileDiagnosis[]
  /** true = deep 成功；'unavailable' = 深度分析不可用（已降级）；false = 未请求。 */
  deep: boolean | 'unavailable'
  suggestions: string[]
}

const ERROR_CODES: IssueCode[] = ['missing', 'not-zstd', 'empty', 'torn', 'reserved-header', 'reserved-block', 'bad-header']
const SUSPICIOUS_CODES: IssueCode[] = ['empty-session', 'oversized-single-frame', 'interrupted', 'stray-file']

const SUGGESTION_TEMPLATES: Record<IssueCode, (n: number) => string> = {
  missing: n => `${n} 个会话文件缺失（记录存在但文件不在）`,
  'not-zstd': n => `${n} 个文件不是 zstd 格式（可能是明文 .jsonl 或损坏）`,
  empty: n => `${n} 个文件为空（0 字节）`,
  torn: n => `${n} 个文件尾部不完整（torn write，可能写入中断）`,
  'reserved-header': n => `${n} 个文件帧头保留位非法（结构损坏）`,
  'reserved-block': n => `${n} 个文件含保留 block 类型（结构损坏）`,
  'bad-header': n => `${n} 个文件首帧不是 session header（deep 模式）`,
  'empty-session': n => `${n} 个会话疑似空会话（只有 header 帧且长期未更新），可考虑清理`,
  'oversized-single-frame': n => `${n} 个会话单帧超大（>1MB，正常多帧写入不会这样）`,
  interrupted: n => `${n} 个会话疑似中断（有 turn/start 无 turn/end，进程被杀/崩溃），可配合 dsh-session-repair 处理`,
  'stray-file': n => `${n} 个 stray 文件（*.tmp / 非标准命名）可清理`,
}

/** 统计 issue 计数（error 与 suspicious 分开）。 */
export function countIssues(detail: FileDiagnosis[]): { errors: Partial<Record<IssueCode, number>>; suspicious: Partial<Record<IssueCode, number>> } {
  const errors: Partial<Record<IssueCode, number>> = {}
  const suspicious: Partial<Record<IssueCode, number>> = {}
  for (const d of detail) {
    for (const issue of d.issues) {
      const bucket = ERROR_CODES.includes(issue) ? errors : suspicious
      bucket[issue] = (bucket[issue] ?? 0) + 1
    }
  }
  return { errors, suspicious }
}

/** 汇总报告。 */
export function buildReport(
  root: string,
  detail: FileDiagnosis[],
  deep: boolean | 'unavailable',
): HealthReport {
  const { errors, suspicious } = countIssues(detail)
  const totals = {
    bytes: detail.reduce((s, d) => s + d.bytes, 0),
    frames: detail.reduce((s, d) => s + (d.frames ?? 0), 0),
    estimatedEventBatches: detail.reduce((s, d) => s + (d.estimatedEventBatches ?? 0), 0),
  }
  const suggestions: string[] = []
  for (const code of [...ERROR_CODES, ...SUSPICIOUS_CODES]) {
    const n = (errors[code] ?? 0) + (suspicious[code] ?? 0)
    if (n > 0) suggestions.push(SUGGESTION_TEMPLATES[code](n))
  }
  if (deep === 'unavailable') {
    suggestions.push('深度分析不可用（无法解析官方解码器）：已降级为帧级扫描')
  }
  return { root, scanned: detail.length, errors, suspicious, totals, detail, deep, suggestions }
}

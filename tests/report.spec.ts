import { describe, expect, it } from 'vitest'
import { buildReport, countIssues, type FileDiagnosis } from '../src/report.ts'

const diag = (issues: FileDiagnosis['issues'], extra: Partial<FileDiagnosis> = {}): FileDiagnosis => ({
  id: 's1', path: '/x/s1/session.jsonl.zstd', bytes: 100, frames: 3,
  estimatedEventBatches: 2, issues, ...extra,
})

describe('countIssues', () => {
  it('splits errors and suspicious buckets', () => {
    const { errors, suspicious } = countIssues([
      diag(['torn']),
      diag(['empty-session', 'torn']),
      diag(['stray-file']),
    ])
    expect(errors).toEqual({ torn: 2 })
    expect(suspicious).toEqual({ 'empty-session': 1, 'stray-file': 1 })
  })
})

describe('buildReport', () => {
  it('aggregates totals and detail', () => {
    const r = buildReport('/root', [
      diag([], { bytes: 10, frames: 2, estimatedEventBatches: 1 }),
      diag(['torn'], { bytes: 20, frames: 1, estimatedEventBatches: 0 }),
    ], false)
    expect(r.scanned).toBe(2)
    expect(r.totals).toEqual({ bytes: 30, frames: 3, estimatedEventBatches: 1 })
    expect(r.errors).toEqual({ torn: 1 })
    expect(r.deep).toBe(false)
  })

  it('generates suggestion templates per issue', () => {
    const r = buildReport('/root', [diag(['torn']), diag(['empty-session']), diag(['stray-file', 'interrupted'])], 'unavailable')
    expect(r.suggestions).toContain('1 个文件尾部不完整（torn write，可能写入中断）')
    expect(r.suggestions).toContain('1 个会话疑似空会话（只有 header 帧且长期未更新），可考虑清理')
    expect(r.suggestions).toContain('1 个 stray 文件（*.tmp / 非标准命名）可清理')
    expect(r.suggestions).toContain('1 个会话疑似中断（有 turn/start 无 turn/end，进程被杀/崩溃），可配合 dsh-session-repair 处理')
    expect(r.suggestions).toContain('深度分析不可用（无法解析官方解码器）：已降级为帧级扫描')
  })

  it('handles an empty result set', () => {
    const r = buildReport('/root', [], false)
    expect(r.scanned).toBe(0)
    expect(r.totals).toEqual({ bytes: 0, frames: 0, estimatedEventBatches: 0 })
    expect(r.suggestions).toEqual([])
  })
})

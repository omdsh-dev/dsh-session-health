/**
 * 深度分析（可选增强）—— 动态 import 官方解码器，统计事件分布与中断检测。
 *
 * 设计：
 * - 编译期零依赖（类型经 any 边界），运行期动态 import；
 * - import 失败（解析不到官方包/加载错误）→ { unavailable: true }，明确降级不静默；
 * - 只读：仅解码读取，不修改文件。
 */

export interface DeepEventStats {
  totalEvents: number
  turnStarts: number
  turnEnds: number
  /** 按事件类型计数（截取前 20 类，防输出膨胀）。 */
  typeCounts: Record<string, number>
}

export interface DeepResult {
  headerValid: boolean
  events: DeepEventStats
  /** 有 turn/start 无 turn/end 的回合数。 */
  interruptedTurns: number
}

/** 官方包的 zstd 模块路径（exports 含 ./src/*）。 */
const ZSTD_IMPORT = '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

/**
 * 深度分析：解码全部帧并统计事件；任何失败返回 { unavailable: true }。
 */
export async function deepAnalyze(path: string): Promise<DeepResult | { unavailable: true }> {
  try {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(path)
    const zstd = await import(ZSTD_IMPORT) as {
      scanZstdFrames: (buffer: Uint8Array) => { frames: Array<{ start: number; end: number }> }
      createZstdFrameDecoder: () => { decode(source: Uint8Array, frames: Array<{ start: number; end: number }>): Generator<Buffer, void, void>; close(): void }
    }
    const scan = zstd.scanZstdFrames(buf)
    const decoder = zstd.createZstdFrameDecoder()
    try {
      const lines: string[] = []
      for (const plain of decoder.decode(buf, scan.frames)) {
        const text = plain.toString('utf-8')
        for (const l of text.split('\n')) {
          const t = l.trim()
          if (t !== '') lines.push(t)
        }
      }
      if (lines.length === 0) {
        return { headerValid: false, events: { totalEvents: 0, turnStarts: 0, turnEnds: 0, typeCounts: {} }, interruptedTurns: 0 }
      }
      const headerValid = lines[0]!.startsWith('{"type":"session"')
      const typeCounts: Record<string, number> = {}
      let turnStarts = 0
      let turnEnds = 0
      for (const l of lines) {
        const type = /"type":"([^"]+)"/.exec(l)?.[1]
        if (type) {
          typeCounts[type] = (typeCounts[type] ?? 0) + 1
          if (type === 'turn/start') turnStarts++
          if (type === 'turn/end') turnEnds++
        }
      }
      const topTypes = Object.fromEntries(Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 20))
      return {
        headerValid,
        events: { totalEvents: lines.length, turnStarts, turnEnds, typeCounts: topTypes },
        interruptedTurns: Math.max(0, turnStarts - turnEnds),
      }
    } finally {
      decoder.close()
    }
  } catch {
    return { unavailable: true }
  }
}

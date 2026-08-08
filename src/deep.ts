/**
 * 深度分析（可选增强）—— 动态 import 官方解码器，统计事件分布与中断检测。
 *
 * 审查 SH-04/SH-05 修复：
 * - **流式统计**：逐帧解码即处理，不保存全部行（只保留跨帧残余半行）；
 * - **资源上限**：压缩文件 > MAX_DEEP_COMPRESSED_BYTES 直接跳过（too-large）；
 *   事件数 > MAX_DEEP_EVENTS 或解压字节 > MAX_DEEP_DECOMPRESSED_BYTES 时停止
 *   消费后续帧（truncated 标记），内存有界；
 * - **错误分类**：动态 import 失败 → decoder-unavailable；读文件失败 →
 *   missing/read-error；扫描/解码/解析失败 → decode-error——损坏文件不再
 *   被伪装成"解码器不可用"；
 * - 只读：仅解码读取，不修改文件。
 */

export interface DeepEventStats {
  totalEvents: number
  turnStarts: number
  turnEnds: number
  /** 按事件类型计数（截取前 20 类，防输出膨胀）。 */
  typeCounts: Record<string, number>
  /** 是否因资源上限提前停止（事件/解压字节超限）。 */
  truncated: boolean
}

export type DeepResult =
  | { status: 'ok'; headerValid: boolean; events: DeepEventStats; interruptedTurns: number }
  | { status: 'decoder-unavailable' }
  | { status: 'missing' }
  | { status: 'read-error'; message: string }
  | { status: 'decode-error'; message: string }
  | { status: 'too-large'; bytes: number }

/** 压缩文件上限：超过则跳过 deep（只做帧级）。 */
export const MAX_DEEP_COMPRESSED_BYTES = 16 * 1024 * 1024
/** 解压总字节上限（达到即停止解码）。 */
export const MAX_DEEP_DECOMPRESSED_BYTES = 64 * 1024 * 1024
/** 事件数上限（达到即停止解码）。 */
export const MAX_DEEP_EVENTS = 200_000

/** 官方包的 zstd 模块路径（exports 含 ./src/*）。 */
const ZSTD_IMPORT = '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

interface OfficialModule {
  scanZstdFrames: (buffer: Uint8Array) => { frames: Array<{ start: number; end: number }> }
  createZstdFrameDecoder: () => {
    decode(source: Uint8Array, frames: Array<{ start: number; end: number }>): Generator<Buffer, void, void>
    close(): void
  }
}

/**
 * 深度分析：流式解码全部帧并统计事件。
 * 任何失败返回带稳定 code 的结果（见 DeepResult），绝不 throw。
 */
export async function deepAnalyze(path: string): Promise<DeepResult> {
  // 1) 解码器可用性（动态 import；失败 = 能力不可用，非文件问题）
  let zstd: OfficialModule
  try {
    zstd = await import(ZSTD_IMPORT) as OfficialModule
  } catch {
    return { status: 'decoder-unavailable' }
  }

  // 2) 读取文件（错误分类：missing / read-error / too-large）
  const { readFile } = await import('node:fs/promises')
  let buf: Uint8Array
  try {
    buf = await readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    return { status: 'read-error', message: String((error as Error).message).slice(0, 200) }
  }
  if (buf.byteLength > MAX_DEEP_COMPRESSED_BYTES) {
    return { status: 'too-large', bytes: buf.byteLength }
  }

  // 3) 帧扫描 + 流式解码统计（扫描/解码/解析错误分类为 decode-error）
  try {
    const scan = zstd.scanZstdFrames(buf)
    const decoder = zstd.createZstdFrameDecoder()
    try {
      const typeCounts: Record<string, number> = {}
      let turnStarts = 0
      let turnEnds = 0
      let totalEvents = 0
      let decompressedBytes = 0
      let truncated = false
      let residual = '' // 跨帧残余半行
      let sawAnyLine = false
      let headerValid = false

      for (const plain of decoder.decode(buf, scan.frames)) {
        if (truncated) break
        decompressedBytes += plain.byteLength
        const text = plain.toString('utf-8')
        // 处理行：残余 + 当前帧逐行
        const lines = (residual + text).split('\n')
        residual = lines.pop() ?? '' // 末段可能不完整，留到下一帧
        for (const raw of lines) {
          const line = raw.trim()
          if (line === '') continue
          if (!sawAnyLine) {
            sawAnyLine = true
            headerValid = line.startsWith('{"type":"session"')
          }
          totalEvents++
          const type = /"type":"([^"]+)"/.exec(line)?.[1]
          if (type) {
            typeCounts[type] = (typeCounts[type] ?? 0) + 1
            if (type === 'turn/start') turnStarts++
            if (type === 'turn/end') turnEnds++
          }
          if (totalEvents >= MAX_DEEP_EVENTS || decompressedBytes >= MAX_DEEP_DECOMPRESSED_BYTES) {
            truncated = true
            break
          }
        }
      }
      if (!truncated && residual.trim() !== '') {
        totalEvents++
        const line = residual.trim()
        if (!sawAnyLine) {
          sawAnyLine = true
          headerValid = line.startsWith('{"type":"session"')
        }
        const type = /"type":"([^"]+)"/.exec(line)?.[1]
        if (type) {
          typeCounts[type] = (typeCounts[type] ?? 0) + 1
          if (type === 'turn/start') turnStarts++
          if (type === 'turn/end') turnEnds++
        }
      }
      const topTypes = Object.fromEntries(Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 20))
      return {
        status: 'ok',
        headerValid,
        events: { totalEvents, turnStarts, turnEnds, typeCounts: topTypes, truncated },
        interruptedTurns: Math.max(0, turnStarts - turnEnds),
      }
    } finally {
      decoder.close()
    }
  } catch (error) {
    return { status: 'decode-error', message: String((error as Error).message).slice(0, 200) }
  }
}

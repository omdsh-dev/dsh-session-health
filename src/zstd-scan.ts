/**
 * zstd 帧边界扫描器 —— 零依赖（DataView 读字节），RFC 8878 帧结构对齐官方
 * `scanZstdFrames`（只解析 frame header + block header，不解码 block 数据）。
 *
 * 用途：会话健康检查的帧级诊断（torn/损坏/帧数统计）。
 * 与官方的差异：官方对非法结构 throw；本工具返回结构化错误码（诊断用途）。
 */

export interface FrameScanResult {
  /** 完整帧数量。 */
  frames: number
  /** 每帧 [start, end) 偏移。 */
  offsets: Array<[number, number]>
  /** 尾部不完整数据起始偏移（torn 检测；无则 undefined）。 */
  tornStart: number | undefined
  error: 'not-zstd' | 'invalid-magic' | 'reserved-header' | 'reserved-block' | 'truncated' | undefined
}

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 扫描一个文件的所有 zstd 帧边界；不解码帧内容。
 * 空输入（0 字节）返回 error: 'not-zstd'（调用方按 empty 归类）。
 * 审查 SH-03 修复：**每一帧开头都校验 magic**——后续帧坏 magic 报
 * 'invalid-magic'（带损坏偏移 tornStart），不再把垃圾误计为完整帧。
 */
export function scanZstdFrames(buf: Uint8Array, maxFrames = Number.POSITIVE_INFINITY): FrameScanResult {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const offsets: Array<[number, number]> = []
  let offset = 0
  const len = buf.byteLength

  const tornAt = (start: number): FrameScanResult =>
    ({ frames: offsets.length, offsets: [...offsets], tornStart: start, error: 'truncated' })

  if (len < 4) {
    return { frames: 0, offsets: [], tornStart: undefined, error: 'not-zstd' }
  }
  if (dv.getUint32(0, true) !== ZSTD_MAGIC) {
    return { frames: 0, offsets: [], tornStart: undefined, error: 'not-zstd' }
  }

  while (offset < len) {
    const start = offset
    // 每帧开头校验 magic（SH-03）
    if (len - offset < 4) return tornAt(start)
    if (dv.getUint32(offset, true) !== ZSTD_MAGIC) {
      return { frames: offsets.length, offsets: [...offsets], tornStart: start, error: 'invalid-magic' }
    }
    // frame header descriptor (1 byte)
    if (len - offset < 5) return tornAt(start)
    const descriptor = dv.getUint8(offset + 4)
    // 保留位（bits 3-4）必须为 0
    if ((descriptor & 0x18) !== 0) {
      return { frames: offsets.length, offsets: [...offsets], tornStart: undefined, error: 'reserved-header' }
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    let p = offset + 5
    if (len - p < remainingHeaderBytes) return tornAt(start)
    p += remainingHeaderBytes

    // block 循环：block header 3 字节（last bit + type + size），逐字节读避免越界
    for (;;) {
      if (len - p < 3) return tornAt(start)
      const blockHeader = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16)
      p += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        return { frames: offsets.length, offsets: [...offsets], tornStart: undefined, error: 'reserved-block' }
      }
      const payloadBytes = blockType !== 0x01 ? blockSize : 1 // RLE 块负载固定 1 字节
      if (len - p < payloadBytes) return tornAt(start)
      p += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (len - p < 4) return tornAt(start)
      p += 4
    }
    offsets.push([start, p])
    offset = p
    if (offsets.length === maxFrames) break
  }

  return { frames: offsets.length, offsets, tornStart: undefined, error: undefined }
}

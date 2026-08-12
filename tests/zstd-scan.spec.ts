import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { scanZstdFrames } from '../src/zstd-scan.ts'

// npm rc.1 tarball 不含 src/（上游 ./src/* export 悬空，见 dsh-external/issues），
// 官方差分对比仅在源码/snapshot 环境可用；npm 独立环境自动跳过。
let officialScan: ((b: Uint8Array) => { frames: Array<{ start: number; end: number }> }) | null = null
try {
  const mod = await import('@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts')
  officialScan = (mod as { scanZstdFrames: typeof officialScan }).scanZstdFrames
} catch {
  officialScan = null
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 用 Node 内置 zstd（与官方压缩器同源的 zstd 帧格式）生成多帧缓冲。 */
function compressZstdFrame(payload: string): Buffer {
  return zstdCompressSync(payload)
}

/** 用 Node 内置 zstd 生成多帧缓冲（每帧独立可解码）。 */
function multiFrame(count: number, payload: string): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < count; i++) {
    parts.push(compressZstdFrame(payload + `-${i}`))
  }
  return Buffer.concat(parts)
}

describe('scanZstdFrames: 帧边界', () => {
  it('scans a single official frame with exact bounds', async () => {
    const buf = compressZstdFrame('hello world')
    const r = scanZstdFrames(buf)
    expect(r.error).toBeUndefined()
    expect(r.frames).toBe(1)
    expect(r.offsets).toEqual([[0, buf.length]])
    expect(r.tornStart).toBeUndefined()
  })

  it.skipIf(officialScan === null)('scans multiple concatenated frames (differential vs official)', async () => {
    const buf = multiFrame(5, 'event batch')
    const mine = scanZstdFrames(buf)
    const official = officialScan!(buf)
    expect(mine.frames).toBe(official.frames.length)
    expect(mine.offsets).toEqual(official.frames.map(f => [f.start, f.end]))
    expect(mine.error).toBeUndefined()
  })

  it('reports not-zstd for plain text', () => {
    expect(scanZstdFrames(Buffer.from('hello, this is not zstd')).error).toBe('not-zstd')
    expect(scanZstdFrames(Buffer.from([1, 2, 3])).error).toBe('not-zstd')
  })

  it('reports truncated for incomplete headers (magic + partial descriptor)', () => {
    // 只有 magic + descriptor（缺 FCS）
    const r = scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x20])]))
    expect(r.error).toBe('truncated')
    expect(r.tornStart).toBe(0)
    expect(r.frames).toBe(0)
  })

  it('reports torn at the frame boundary when the tail is cut', async () => {
    const buf = multiFrame(3, 'data')
    const full = scanZstdFrames(buf)
    expect(full.frames).toBe(3)
    const thirdStart = full.offsets[2]![0]
    const cut = buf.subarray(0, thirdStart + 10) // 第三帧被截断
    const r = scanZstdFrames(cut)
    expect(r.error).toBe('truncated')
    expect(r.frames).toBe(2) // 前两帧完整
    expect(r.tornStart).toBe(thirdStart)
  })

  it('reports reserved block type', () => {
    // descriptor: single-segment(0x20) + FCS 1 字节(0) + 无 dict + 无 checksum
    // block header: type=3(reserved), last=1 → (3<<1)|1 = 0x07
    const buf = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x07, 0x00, 0x00])
    expect(scanZstdFrames(buf).error).toBe('reserved-block')
  })

  it('reports reserved frame-header bits', () => {
    // descriptor 0x10（bit4 保留位被置位）
    const buf = Buffer.concat([MAGIC, Buffer.from([0x10]), Buffer.from([0x00])])
    expect(scanZstdFrames(buf).error).toBe('reserved-header')
  })

  it('respects maxFrames', async () => {
    const buf = multiFrame(4, 'x')
    const r = scanZstdFrames(buf, 2)
    expect(r.frames).toBe(2)
    expect(r.error).toBeUndefined()
  })

  // ── SH-03：每一帧校验 magic ──

  it('reports invalid-magic when a later frame starts with garbage (SH-03)', async () => {
    const good = compressZstdFrame('hello')
    // 合法形状的垃圾帧：坏 magic（de ad be ef）但 descriptor/block 结构可解析
    const garbage = Buffer.concat([good, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x20, 0x00, 0x05, 0x00, 0x00])])
    const r = scanZstdFrames(garbage)
    expect(r.error).toBe('invalid-magic')
    expect(r.frames).toBe(1) // 只有首帧被统计
    expect(r.tornStart).toBe(good.length) // 垃圾帧起点（帧长随压缩器参数而定）
  })

  it('reports invalid-magic for a bad middle frame (SH-03)', async () => {
    const a = compressZstdFrame('a')
    const b = compressZstdFrame('b')
    const c = compressZstdFrame('c')
    const bad = Buffer.concat([a, b, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x20, 0x00, 0x05, 0x00, 0x00]), c])
    const r = scanZstdFrames(bad)
    expect(r.error).toBe('invalid-magic')
    expect(r.frames).toBe(2)
    expect(r.tornStart).toBe(a.length + b.length)
  })

  it.skipIf(officialScan === null)('still matches the official scanner on clean multi-frame input (regression)', async () => {
    const buf = multiFrame(5, 'clean')
    const mine = scanZstdFrames(buf)
    const official = officialScan!(buf)
    expect(mine.frames).toBe(official.frames.length)
    expect(mine.error).toBeUndefined()
  })
})

describe('scanZstdFrames: 真实会话差分（隐私安全：只读本机 ~/.dsh/sessions，不入库）', () => {
  const root = join(homedir(), '.dsh', 'sessions')
  const files: string[] = []
  try {
    for (const top of readdirSync(root)) {
      const topDir = join(root, top)
      if (!statSync(topDir).isDirectory()) continue
      for (const mid of readdirSync(topDir)) {
        const f = join(topDir, mid, 'session.jsonl.zstd')
        try { if (statSync(f).isFile()) files.push(f) } catch { /* 跳过 */ }
      }
    }
  } catch { /* sessions 目录不存在 */ }

  const pick = files
    .sort((a, b) => statSync(b).size - statSync(a).size)
    .filter((_, i) => i === 0 || i === Math.floor(files.length / 2) || i === files.length - 1)
    .slice(0, 3)

  it.skipIf(pick.length === 0 || officialScan === null)('frame counts match the official scanner on real files (大/中/小)', async () => {
    for (const f of pick) {
      const buf = readFileSync(f)
      const mine = scanZstdFrames(buf)
      const official = officialScan!(buf)
      expect(mine.frames, f).toBe(official.frames.length)
      expect(mine.error, f).toBeUndefined()
      expect(mine.offsets, f).toEqual(official.frames.map(x => [x.start, x.end]))
    }
  })
})

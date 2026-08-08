import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumerateSessions, resolveSessionPath, isWithin, resolveDshHome } from '../src/files.ts'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-sessions-'))
  // <cwd 编码目录>/<session-id>/session.jsonl.zstd
  mkdirSync(join(root, '--C-Users-admin-Desktop-test--', 'session-abc'), { recursive: true })
  writeFileSync(join(root, '--C-Users-admin-Desktop-test--', 'session-abc', 'session.jsonl.zstd'), 'data')
  mkdirSync(join(root, '--C-Users-admin-Desktop-test--', 'session-xyz'), { recursive: true })
  writeFileSync(join(root, '--C-Users-admin-Desktop-test--', 'session-xyz', 'session.jsonl.zstd'), 'data2')
  // stray 与明文变体
  writeFileSync(join(root, '--C-Users-admin-Desktop-test--', 'leftover.tmp'), 'x')
  writeFileSync(join(root, '--C-Users-admin-Desktop-test--', 'session-abc', 'plain.jsonl'), 'y')
  writeFileSync(join(root, '--C-Users-admin-Desktop-test--', 'session-abc', 'extra.bin'), 'z') // 不相关文件，忽略
  return root
}

describe('enumerateSessions', () => {
  it('finds zstd/jsonl/stray files in the two-level layout', async () => {
    const root = makeRoot()
    const { files, warnings } = await enumerateSessions(root)
    const names = files.map(f => `${f.id}:${f.kind}`).sort()
    expect(names).toEqual([
      'leftover.tmp:stray',
      'plain.jsonl:jsonl',
      'session-abc:zstd',
      'session-xyz:zstd',
    ])
    expect(warnings).toEqual([])
  })

  it('returns a warning when the root does not exist', async () => {
    const { files, warnings } = await enumerateSessions(join(tmpdir(), 'no-such-sessions-dir-xyz'))
    expect(files).toEqual([])
    expect(warnings[0]).toMatch(/does not exist/)
  })
})

describe('resolveSessionPath', () => {
  it('resolves a session id to its file', async () => {
    const root = makeRoot()
    const p = await resolveSessionPath(root, 'session-abc')
    expect(p.endsWith(join('--C-Users-admin-Desktop-test--', 'session-abc', 'session.jsonl.zstd'))).toBe(true)
  })

  it('rejects unknown session ids', async () => {
    await expect(resolveSessionPath(makeRoot(), 'session-nope')).rejects.toThrow('session_health: session not found')
  })

  it('accepts absolute paths inside the root', async () => {
    const root = makeRoot()
    const target = join(root, '--C-Users-admin-Desktop-test--', 'session-abc', 'session.jsonl.zstd')
    expect(await resolveSessionPath(root, target)).toBe(target)
  })

  it('rejects absolute paths outside the root (arbitrary file read guard)', async () => {
    await expect(resolveSessionPath(makeRoot(), 'C:\\Windows\\win.ini')).rejects.toThrow(/outside the sessions root/)
    await expect(resolveSessionPath(makeRoot(), 'C:/Windows/win.ini')).rejects.toThrow(/outside the sessions root/)
  })

  it('rejects an empty path', async () => {
    await expect(resolveSessionPath(makeRoot(), '')).rejects.toThrow('session_health: path must not be empty')
  })

  // ── SH-01：路径穿越 ──

  it('rejects ../ traversal in session ids (SH-01)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sh-traversal-'))
    const root = join(base, 'sessions')
    mkdirSync(root)
    mkdirSync(join(base, 'outside'), { recursive: true })
    writeFileSync(join(base, 'outside', 'session.jsonl.zstd'), 'secret')
    await expect(resolveSessionPath(root, '../outside')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, '../../outside')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, '..\\outside')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, 'a/../../outside')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, '..')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, '.')).rejects.toThrow(/invalid session id/)
    await expect(resolveSessionPath(root, '\\\\server\\share\\x')).rejects.toThrow(/invalid session id/)
    // 绝对路径走绝对分支（同样被围栏拒绝）
    await expect(resolveSessionPath(root, 'C:/Windows/win.ini')).rejects.toThrow(/outside the sessions root/)
  })

  // ── SH-02：符号链接逃逸 ──

  it('rejects a session symlink pointing outside the root (SH-02)', async () => {
    const root = makeRoot()
    const secret = join(tmpdir(), `sh-secret-${Date.now()}`)
    writeFileSync(secret, 'top secret')
    const linkDir = join(root, '--C-Users-admin-Desktop-test--', 'session-link')
    mkdirSync(linkDir, { recursive: true })
    try {
      symlinkSync(secret, join(linkDir, 'session.jsonl.zstd'))
    } catch {
      // 环境不支持 symlink 时跳过（Windows 无权限场景）
      return
    }
    await expect(resolveSessionPath(root, join(linkDir, 'session.jsonl.zstd')))
      .rejects.toThrow(/outside the sessions root|symbolic links/)
  })

  it('skips symbolic links during enumeration (SH-02)', async () => {
    const root = makeRoot()
    const secret = join(tmpdir(), `sh-secret2-${Date.now()}`)
    writeFileSync(secret, 'x')
    try {
      symlinkSync(secret, join(root, '--C-Users-admin-Desktop-test--', 'session-abc', 'link.tmp'))
    } catch {
      return
    }
    const { files } = await enumerateSessions(root)
    expect(files.some(f => f.id === 'link.tmp')).toBe(false)
  })

  // ── SH-06：只读保证 ──

  it('does not modify any file during enumeration (read-only, SH-06)', async () => {
    const root = makeRoot()
    const files = await enumerateSessions(root)
    const before = new Map<string, Buffer>()
    for (const f of files.files) before.set(f.path, readFileSync(f.path))
    // 再次枚举 + 全部重读
    const files2 = await enumerateSessions(root)
    for (const f of files2.files) {
      const b = before.get(f.path)
      if (b) expect(readFileSync(f.path).equals(b)).toBe(true)
    }
  })
})

describe('isWithin', () => {
  it('handles exact, nested and escaping paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-within-'))
    expect(await isWithin(root, root)).toBe(true)
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(await isWithin(root, nested)).toBe(true)
    expect(await isWithin(root, join(root, '..', 'x'))).toBe(false)
    // 不存在的 target → false（realpath 失败）
    expect(await isWithin(root, join(root, 'no-such-dir'))).toBe(false)
  })
})

describe('resolveDshHome', () => {
  it('prefers DSH_HOME and falls back to ~/.dsh', () => {
    expect(resolveDshHome({ DSH_HOME: 'C:/custom/dsh' } as NodeJS.ProcessEnv)).toBe('C:/custom/dsh')
    expect(resolveDshHome({} as NodeJS.ProcessEnv)).toBe(join(require('node:os').homedir(), '.dsh'))
  })
})

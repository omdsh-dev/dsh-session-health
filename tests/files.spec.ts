import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
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
})

describe('isWithin', () => {
  it('handles exact, nested and escaping paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-within-'))
    expect(await isWithin(root, root)).toBe(true)
    expect(await isWithin(root, join(root, 'a', 'b'))).toBe(true)
    expect(await isWithin(root, join(root, '..', 'x'))).toBe(false)
  })
})

describe('resolveDshHome', () => {
  it('prefers DSH_HOME and falls back to ~/.dsh', () => {
    expect(resolveDshHome({ DSH_HOME: 'C:/custom/dsh' } as NodeJS.ProcessEnv)).toBe('C:/custom/dsh')
    expect(resolveDshHome({} as NodeJS.ProcessEnv)).toBe(join(require('node:os').homedir(), '.dsh'))
  })
})

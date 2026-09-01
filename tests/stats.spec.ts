import { describe, expect, it, vi, afterEach } from 'vitest'
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sh-home-'))
  const dir = join(home, 'sessions', '--C-Users-admin-Desktop-test--', 'session-abc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl.zstd'), 'data')
  return home
}

function capturedTool(): any {
  let captured: unknown
  const ctx: any = { tools: { register: (def: unknown) => { captured = def; return () => {} } } }
  apply(ctx)
  return captured as any
}

describe('session_health: stats action (whole-directory totals, no path)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('returns totals without a path', async () => {
    vi.stubEnv('DSH_HOME', makeHome())
    const def = capturedTool()
    const result = JSON.parse(await def.execute({ action: 'stats' }, {}))
    expect(result.scanned).toBe(1)
    expect(result.totals.bytes).toBeGreaterThan(0)
    expect(result.detail).toEqual([])
  })

  it('ignores path for stats (path belongs to the file action)', async () => {
    vi.stubEnv('DSH_HOME', makeHome())
    const def = capturedTool()
    const result = JSON.parse(await def.execute({ action: 'stats', path: 'session-abc' }, {}))
    expect(result.scanned).toBe(1)
    expect(result.detail).toEqual([])
  })

  it('still requires a path for the file action', async () => {
    vi.stubEnv('DSH_HOME', makeHome())
    const def = capturedTool()
    await expect(def.execute({ action: 'file' }, {})).rejects.toThrow(
      'session_health: file requires a path or session id',
    )
  })
})

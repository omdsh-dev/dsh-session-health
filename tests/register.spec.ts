import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
import { name, inject, apply } from '../src/index.ts'

describe('session_health: plugin registration contract (AUDIT-CROSS-02)', () => {
  it('exports the cordis plugin contract', () => {
    expect(typeof name).toBe('string')
    expect(name).toBe('@deepseek-ai/dsh-session-health')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('registers the session_health tool with schema + render', () => {
    let captured: unknown
    const ctx: any = { tools: { register: (def: unknown) => { captured = def; return () => {} } } }
    apply(ctx)
    const def = captured as any
    expect(def.name).toBe('session_health')
    expect(def.parameters.action.required).toBe(true)
    expect(def.parameters.action.enum).toEqual(['scan', 'file', 'stats'])
    expect(def.parameters.path.type).toBe('string')
    expect(typeof def.output.render).toBe('function')
    expect(def.timeoutMs).toBeGreaterThan(0)
  })
})

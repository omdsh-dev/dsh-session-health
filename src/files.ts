/**
 * 会话目录枚举 —— 只读扫描 $DSH_HOME/sessions 两级布局。
 *
 * 布局（实测）：<root>/<cwd 编码目录>/<session-id>/session.jsonl.zstd
 * cwd 编码：`C:\Users\admin\Desktop\dshext` → `--C-Users-admin-Desktop-dshext--`
 * （`\`→`-`、盘符 `C:`→`C-`、外层包裹 `--`）。
 *
 * 安全：file 动作的 path 解析结果必须落在 sessions 根内（防止任意文件读取）。
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function sessionsRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

export interface SessionFile {
  /** 会话 id（目录名）或文件名（stray 文件）。 */
  id: string
  /** 绝对路径。 */
  path: string
  kind: 'zstd' | 'jsonl' | 'stray'
  bytes: number
  /** mtime（epoch ms）。 */
  updatedAt: number
}

export interface EnumerateResult {
  files: SessionFile[]
  /** 目录读取失败等非致命告警。 */
  warnings: string[]
}

/**
 * 递归枚举 sessions 根下的会话文件与 stray 文件。
 * 只读：绝不修改/删除任何文件。
 */
export async function enumerateSessions(root: string): Promise<EnumerateResult> {
  const files: SessionFile[] = []
  const warnings: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`cannot read directory ${dir}: ${(error as Error).message}`)
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      try {
        const stat = await fs.stat(full)
        if (entry.isDirectory()) {
          if (depth < 2) await walk(full, depth + 1)
          continue
        }
        if (entry.name === 'session.jsonl.zstd') {
          files.push({ id: dir.split(sep).pop() ?? entry.name, path: full, kind: 'zstd', bytes: stat.size, updatedAt: stat.mtimeMs })
        } else if (entry.name.endsWith('.jsonl')) {
          files.push({ id: entry.name, path: full, kind: 'jsonl', bytes: stat.size, updatedAt: stat.mtimeMs })
        } else if (entry.name.endsWith('.tmp') || entry.name.endsWith('.tmp.zstd')) {
          files.push({ id: entry.name, path: full, kind: 'stray', bytes: stat.size, updatedAt: stat.mtimeMs })
        }
      } catch {
        // 单个文件 stat 失败：跳过（权限等）
        warnings.push(`cannot stat ${full}`)
      }
    }
  }

  try {
    await fs.access(root)
  } catch {
    return { files: [], warnings: [`sessions root does not exist: ${root}`] }
  }
  await walk(root, 0)
  return { files, warnings }
}

/** 路径是否位于 root（真实路径比较，防符号链接逃逸）。 */
export async function isWithin(root: string, target: string): Promise<boolean> {
  const rootReal = resolve(root)
  const targetReal = resolve(target)
  if (targetReal === rootReal) return true
  return targetReal.startsWith(rootReal + sep)
}

/**
 * file 动作的 path 解析：接受绝对文件路径（必须在 root 内）或会话 id。
 * 返回目标文件路径；不存在或越界抛 session_health: 错误。
 */
export async function resolveSessionPath(root: string, pathOrId: string): Promise<string> {
  if (pathOrId === '') throw new Error('session_health: path must not be empty')

  // 绝对路径（Windows 盘符或 / 开头）
  if (/^[a-zA-Z]:[\\/]/.test(pathOrId) || pathOrId.startsWith('/')) {
    if (!(await isWithin(root, pathOrId))) {
      throw new Error(`session_health: path is outside the sessions root: ${pathOrId}`)
    }
    // 目录 → 找 session.jsonl.zstd；文件 → 直接用
    let stat
    try {
      stat = await fs.stat(pathOrId)
    } catch {
      throw new Error(`session_health: path not found: ${pathOrId}`)
    }
    if (stat.isDirectory()) {
      const inner = join(pathOrId, 'session.jsonl.zstd')
      try {
        await fs.access(inner)
        return inner
      } catch {
        throw new Error(`session_health: no session.jsonl.zstd inside ${pathOrId}`)
      }
    }
    return pathOrId
  }

  // 会话 id：在 root 下两级查找 <cwd 目录>/<id>/session.jsonl.zstd
  const candidates: string[] = []
  const dirs = await fs.readdir(root).catch(() => [] as string[])
  for (const d of dirs) {
    candidates.push(join(root, d, pathOrId, 'session.jsonl.zstd'))
  }
  candidates.push(join(root, pathOrId, 'session.jsonl.zstd'))
  for (const c of candidates) {
    try {
      await fs.access(c)
      return c
    } catch { /* 继续 */ }
  }
  throw new Error(`session_health: session not found: ${pathOrId}`)
}

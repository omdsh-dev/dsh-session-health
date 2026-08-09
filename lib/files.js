/**
 * 会话目录枚举 —— 只读扫描 $DSH_HOME/sessions 两级布局。
 *
 * 布局（实测）：<root>/<cwd 编码目录>/<session-id>/session.jsonl.zstd
 * cwd 编码：`C:\Users\admin\Desktop\dshext` → `--C-Users-admin-Desktop-dshext--`
 * （`\`→`-`、盘符 `C:`→`C-`、外层包裹 `--`）。
 *
 * 安全（审查 SH-01/SH-02 修复）：
 * - session id 只允许严格目录名（`[A-Za-z0-9._-]+`），显式拒绝 `/`、`\`、`..`、
 *   驱动器前缀、空白与控制字符——`..` 路径穿越不可能；
 * - 围栏判定使用 **fs.realpath 真实路径**（非词法 resolve），符号链接/junction
 *   指向根外时被拒绝；枚举用 lstat 并默认拒绝 symlink；
 * - 解析结果在返回前再次做真实路径 containment 校验。
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export function resolveDshHome(env = process.env) {
    return env.DSH_HOME ?? join(homedir(), '.dsh');
}
export function sessionsRoot(dshHome) {
    return join(dshHome, 'sessions');
}
/** 严格会话 id：单个目录名，无路径分隔符/点相对/驱动器/空白控制字符。 */
export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
/** 相对路径 id 中的穿越片段（在 join 前拒绝）。 */
const TRAVERSAL_RE = /(^|[\\/])\.\.([\\/]|$)|[\\/]|^[a-zA-Z]:/;
/**
 * 真实路径 containment：root 与 target 均 realpath 后判定。
 * 符号链接/junction 指向根外 → false（词法 resolve 无法发现）；
 * target 不存在（realpath 失败）→ false。
 */
export async function isWithin(root, target) {
    let rootReal;
    let targetReal;
    try {
        ;
        [rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    }
    catch {
        return false;
    }
    if (targetReal === rootReal)
        return true;
    return targetReal.startsWith(rootReal + sep);
}
/**
 * 递归枚举 sessions 根下的会话文件与 stray 文件。
 * 只读：绝不修改/删除任何文件。
 * 安全：lstat 判定，符号链接条目一律拒绝（不跟随）。
 */
export async function enumerateSessions(root) {
    const files = [];
    const warnings = [];
    const walk = async (dir, depth) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            warnings.push(`cannot read directory ${dir}: ${error.message}`);
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            let stat;
            try {
                stat = await fs.lstat(full);
            }
            catch {
                warnings.push(`cannot stat ${full}`);
                continue;
            }
            if (stat.isSymbolicLink()) {
                warnings.push(`skipping symbolic link: ${full}`);
                continue;
            }
            if (stat.isDirectory()) {
                if (depth < 2)
                    await walk(full, depth + 1);
                continue;
            }
            if (!stat.isFile())
                continue;
            if (entry.name === 'session.jsonl.zstd') {
                files.push({ id: dir.split(sep).pop() ?? entry.name, path: full, kind: 'zstd', bytes: stat.size, updatedAt: stat.mtimeMs });
            }
            else if (entry.name.endsWith('.jsonl')) {
                files.push({ id: entry.name, path: full, kind: 'jsonl', bytes: stat.size, updatedAt: stat.mtimeMs });
            }
            else if (entry.name.endsWith('.tmp') || entry.name.endsWith('.tmp.zstd')) {
                files.push({ id: entry.name, path: full, kind: 'stray', bytes: stat.size, updatedAt: stat.mtimeMs });
            }
        }
    };
    try {
        await fs.access(root);
    }
    catch {
        return { files: [], warnings: [`sessions root does not exist: ${root}`] };
    }
    await walk(root, 0);
    return { files, warnings };
}
/**
 * file 动作的 path 解析：接受绝对文件路径（真实路径必须在 root 内）或严格会话 id。
 * 返回目标文件路径；不存在/越界/含穿越抛 session_health: 错误。
 */
export async function resolveSessionPath(root, pathOrId) {
    if (pathOrId === '')
        throw new Error('session_health: path must not be empty');
    // 绝对路径分支（Windows 盘符或 / 开头）：真实路径 containment
    if (/^[a-zA-Z]:[\\/]/.test(pathOrId) || pathOrId.startsWith('/')) {
        let stat;
        try {
            stat = await fs.lstat(pathOrId);
        }
        catch {
            throw new Error(`session_health: path not found: ${pathOrId}`);
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`session_health: symbolic links are not allowed: ${pathOrId}`);
        }
        if (!(await isWithin(root, pathOrId))) {
            throw new Error(`session_health: path is outside the sessions root: ${pathOrId}`);
        }
        if (stat.isDirectory()) {
            const inner = join(pathOrId, 'session.jsonl.zstd');
            try {
                await fs.access(inner);
            }
            catch {
                throw new Error(`session_health: no session.jsonl.zstd inside ${pathOrId}`);
            }
            if (!(await isWithin(root, inner))) {
                throw new Error(`session_health: path is outside the sessions root: ${pathOrId}`);
            }
            return inner;
        }
        return pathOrId;
    }
    // 会话 id 分支：严格目录名（防 ../ 穿越、防绝对路径混入、防 . / .. 单点名）
    if (!SESSION_ID_RE.test(pathOrId) || TRAVERSAL_RE.test(pathOrId) || /^\.+$/.test(pathOrId)) {
        throw new Error(`session_health: invalid session id "${pathOrId}" (must be a plain directory name)`);
    }
    // 两级查找 <cwd 目录>/<id>/session.jsonl.zstd 或 <id>/session.jsonl.zstd
    const candidates = [];
    const dirs = await fs.readdir(root).catch(() => []);
    for (const d of dirs) {
        if (!SESSION_ID_RE.test(d))
            continue;
        candidates.push(join(root, d, pathOrId, 'session.jsonl.zstd'));
    }
    candidates.push(join(root, pathOrId, 'session.jsonl.zstd'));
    for (const c of candidates) {
        try {
            await fs.access(c);
        }
        catch {
            continue;
        }
        // 最终文件再次真实路径 containment（防根内 symlink 指向根外）
        if (!(await isWithin(root, c))) {
            throw new Error(`session_health: session resolves outside the sessions root: ${pathOrId}`);
        }
        return c;
    }
    throw new Error(`session_health: session not found: ${pathOrId}`);
}

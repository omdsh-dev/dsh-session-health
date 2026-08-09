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
/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
export declare function sessionsRoot(dshHome: string): string;
export interface SessionFile {
    /** 会话 id（目录名）或文件名（stray 文件）。 */
    id: string;
    /** 绝对路径。 */
    path: string;
    kind: 'zstd' | 'jsonl' | 'stray';
    bytes: number;
    /** mtime（epoch ms）。 */
    updatedAt: number;
}
export interface EnumerateResult {
    files: SessionFile[];
    /** 目录读取失败等非致命告警。 */
    warnings: string[];
}
/** 严格会话 id：单个目录名，无路径分隔符/点相对/驱动器/空白控制字符。 */
export declare const SESSION_ID_RE: RegExp;
/**
 * 真实路径 containment：root 与 target 均 realpath 后判定。
 * 符号链接/junction 指向根外 → false（词法 resolve 无法发现）；
 * target 不存在（realpath 失败）→ false。
 */
export declare function isWithin(root: string, target: string): Promise<boolean>;
/**
 * 递归枚举 sessions 根下的会话文件与 stray 文件。
 * 只读：绝不修改/删除任何文件。
 * 安全：lstat 判定，符号链接条目一律拒绝（不跟随）。
 */
export declare function enumerateSessions(root: string): Promise<EnumerateResult>;
/**
 * file 动作的 path 解析：接受绝对文件路径（真实路径必须在 root 内）或严格会话 id。
 * 返回目标文件路径；不存在/越界/含穿越抛 session_health: 错误。
 */
export declare function resolveSessionPath(root: string, pathOrId: string): Promise<string>;

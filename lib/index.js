/**
 * DSH 会话健康检查插件。
 *
 * 注册 `session_health` 工具：扫描 $DSH_HOME/sessions 下的多帧 zstd 会话文件，
 * 诊断 torn/损坏/空会话等问题，输出健康报告与清理建议。
 * 接入方式：在 cordis.yml 追加：
 *   - id: tool-session-health
 *     name: '@deepseek-ai/dsh-session-health'
 *
 * 安全边界：**只读诊断**（绝不修改/删除任何文件）；file 动作的路径必须落在
 * sessions 根内（防任意文件读取）；zero 业务依赖（帧扫描零依赖实现）；
 * deep 模式动态 import 官方解码器，失败明确降级 deep: unavailable。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { scanZstdFrames } from "./zstd-scan.js";
import { enumerateSessions, resolveDshHome, resolveSessionPath, sessionsRoot } from "./files.js";
import { buildReport } from "./report.js";
import { deepAnalyze } from "./deep.js";
export const name = '@deepseek-ai/dsh-session-health';
export const inject = ['tools'];
/** 空会话判定：只有 header 帧且超过 1 分钟未更新。 */
const EMPTY_SESSION_AGE_MS = 60_000;
/** 单帧超大判定。 */
const OVERSIZED_SINGLE_FRAME_BYTES = 1_000_000;
/** 帧级诊断单个文件。 */
export async function diagnoseFile(f, now = Date.now()) {
    const base = {
        id: f.id, path: f.path, bytes: f.bytes, frames: null,
        estimatedEventBatches: null, issues: [],
    };
    if (f.kind === 'stray') {
        base.issues.push('stray-file');
        return base;
    }
    if (f.bytes === 0) {
        base.issues.push('empty');
        return base;
    }
    if (f.kind === 'jsonl') {
        // 明文 .jsonl 变体不是新格式的 zstd 会话产物
        base.issues.push('not-zstd');
        return base;
    }
    const buf = await readFile(f.path);
    const scan = scanZstdFrames(buf);
    base.frames = scan.frames;
    base.estimatedEventBatches = scan.frames > 0 ? Math.max(0, scan.frames - 1) : null;
    switch (scan.error) {
        case 'not-zstd':
            base.issues.push('not-zstd');
            return base;
        case 'reserved-header':
            base.issues.push('reserved-header');
            return base;
        case 'reserved-block':
            base.issues.push('reserved-block');
            return base;
        case 'truncated':
            base.issues.push('torn');
            return base;
    }
    if (scan.frames === 1) {
        if (f.bytes > OVERSIZED_SINGLE_FRAME_BYTES)
            base.issues.push('oversized-single-frame');
        if (now - f.updatedAt > EMPTY_SESSION_AGE_MS)
            base.issues.push('empty-session');
    }
    return base;
}
/** 对诊断结果附加 deep 分析（错误分类见 DeepResult；映射为对应 issue 码）。 */
async function attachDeep(d) {
    const deep = await deepAnalyze(d.path);
    if (deep.status === 'ok') {
        if (!deep.headerValid)
            d.issues.push('bad-header');
        if (deep.interruptedTurns > 0)
            d.issues.push('interrupted');
    }
    else if (deep.status === 'decode-error') {
        d.issues.push('deep-corrupt');
    }
    else if (deep.status === 'missing') {
        d.issues.push('missing');
    }
    else if (deep.status === 'read-error') {
        d.issues.push('deep-read-error');
    }
    else if (deep.status === 'too-large') {
        d.issues.push('deep-skipped-large');
    }
    // decoder-unavailable：不产生文件级 issue，由报告级 deep 状态标注
    return { ...d, deepInfo: deep };
}
/** 汇总 deep 状态：任一文件 decoder-unavailable → 'unavailable'。 */
function deepStatusOf(detail) {
    if (detail.length === 0)
        return true;
    return detail.some(d => d.deepInfo?.status === 'decoder-unavailable') ? 'unavailable' : true;
}
async function runAction(args) {
    const dshHome = resolveDshHome();
    const root = sessionsRoot(dshHome);
    const deepRequested = args.deep === true;
    const detailRequested = args.detail !== false;
    if (args.action === 'scan') {
        const { files, warnings } = await enumerateSessions(root);
        const detail = [];
        for (const f of files) {
            const d = await diagnoseFile(f);
            if (deepRequested) {
                detail.push(await attachDeep(d));
            }
            else {
                detail.push(d);
            }
        }
        const deepStatus = deepRequested ? deepStatusOf(detail) : false;
        const report = buildReport(root, detail, deepStatus);
        // scan 默认 detail 只列异常文件；detail=false 时全量省略
        const shown = detailRequested
            ? detail.filter(d => d.issues.length > 0).map(d => ({
                id: d.id, path: d.path, frames: d.frames, bytes: d.bytes,
                estimatedEventBatches: d.estimatedEventBatches, issues: d.issues,
                ...(d.deepInfo ? { deepInfo: d.deepInfo } : {}),
            }))
            : [];
        report.detail = shown;
        for (const w of warnings)
            report.suggestions.push(w);
        return JSON.stringify(report);
    }
    if (args.action === 'file' || args.action === 'stats') {
        if (typeof args.path !== 'string' || args.path === '') {
            throw new Error('session_health: file/stats require a path or session id');
        }
        const target = await resolveSessionPath(root, args.path);
        const stat = await fs.stat(target);
        const kind = target.endsWith('.jsonl.zstd')
            ? 'zstd'
            : target.endsWith('.jsonl')
                ? 'jsonl'
                : 'stray';
        const f = { id: target.split(/[\\/]/).pop() ?? args.path, path: target, kind, bytes: stat.size, updatedAt: stat.mtimeMs };
        const d = await diagnoseFile(f);
        const withDeep = deepRequested ? await attachDeep(d) : d;
        const report = buildReport(root, [withDeep], deepRequested ? deepStatusOf([withDeep]) : false);
        if (args.action === 'stats' || !detailRequested) {
            report.detail = [];
        }
        return JSON.stringify(report);
    }
    throw new Error(`session_health: unknown action "${args.action}"`);
}
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'session_health',
        description: 'Diagnose dsh session files under $DSH_HOME/sessions (multi-frame zstd scan: ' +
            'torn writes, corruption, empty sessions, stray files). Read-only: never ' +
            'modifies or deletes any file. Actions: scan (whole directory health report), ' +
            'file (diagnose one file by absolute path inside the sessions root or by ' +
            'session id), stats (totals only). deep=true additionally decodes events ' +
            '(requires the official decoder; degrades to frame-level with deep: "unavailable" ' +
            'when it cannot resolve).',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ['scan', 'file', 'stats'],
                description: 'Operation to perform.',
            },
            path: {
                type: 'string',
                description: 'Session file path (inside the sessions root) or session id (file action).',
            },
            deep: {
                type: 'boolean',
                description: 'Deep analysis: decode events via the official decoder. Default false (frame-level scan only).',
            },
            detail: {
                type: 'boolean',
                description: 'List every abnormal file (default true for scan). Set false for a summary-only report.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: args => runAction(args),
        timeoutMs: 5000,
    }));
}

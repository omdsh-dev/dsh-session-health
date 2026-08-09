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
import type { Context } from 'cordis';
import { type SessionFile } from './files.ts';
import { type FileDiagnosis } from './report.ts';
export declare const name = "@deepseek-ai/dsh-session-health";
export declare const inject: string[];
/** 帧级诊断单个文件。 */
export declare function diagnoseFile(f: SessionFile, now?: number): Promise<FileDiagnosis>;
export declare function apply(ctx: Context): void;

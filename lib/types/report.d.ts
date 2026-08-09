/**
 * 健康报告生成 —— 帧级诊断结果 → 报告 JSON + suggestions 模板。
 * 只读诊断：不修改/删除任何文件。
 */
export type IssueCode = 'missing' | 'not-zstd' | 'invalid-magic' | 'empty' | 'torn' | 'reserved-header' | 'reserved-block' | 'bad-header' | 'empty-session' | 'oversized-single-frame' | 'interrupted' | 'stray-file' | 'deep-corrupt' | 'deep-read-error' | 'deep-skipped-large';
/** 单文件诊断。 */
export interface FileDiagnosis {
    id: string;
    path: string;
    bytes: number;
    frames: number | null;
    /** 帧数 - 1 ≈ 事件批次下限（估算，非精确事件数）。 */
    estimatedEventBatches: number | null;
    issues: IssueCode[];
}
export interface HealthReport {
    root: string;
    scanned: number;
    errors: Partial<Record<IssueCode, number>>;
    suspicious: Partial<Record<IssueCode, number>>;
    totals: {
        bytes: number;
        frames: number;
        estimatedEventBatches: number;
    };
    detail: FileDiagnosis[];
    /** true = deep 成功；'unavailable' = 深度分析不可用（已降级）；false = 未请求。 */
    deep: boolean | 'unavailable';
    suggestions: string[];
}
/** 统计 issue 计数（error 与 suspicious 分开）。 */
export declare function countIssues(detail: FileDiagnosis[]): {
    errors: Partial<Record<IssueCode, number>>;
    suspicious: Partial<Record<IssueCode, number>>;
};
/** 汇总报告。 */
export declare function buildReport(root: string, detail: FileDiagnosis[], deep: boolean | 'unavailable'): HealthReport;

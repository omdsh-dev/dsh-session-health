/**
 * 深度分析（可选增强）—— 动态 import 官方解码器，统计事件分布与中断检测。
 *
 * 审查 SH-04/SH-05 修复：
 * - **流式统计**：逐帧解码即处理，不保存全部行（只保留跨帧残余半行）；
 * - **资源上限**：压缩文件 > MAX_DEEP_COMPRESSED_BYTES 直接跳过（too-large）；
 *   事件数 > MAX_DEEP_EVENTS 或解压字节 > MAX_DEEP_DECOMPRESSED_BYTES 时停止
 *   消费后续帧（truncated 标记），内存有界；
 * - **错误分类**：动态 import 失败 → decoder-unavailable；读文件失败 →
 *   missing/read-error；扫描/解码/解析失败 → decode-error——损坏文件不再
 *   被伪装成"解码器不可用"；
 * - 只读：仅解码读取，不修改文件。
 */
export interface DeepEventStats {
    totalEvents: number;
    turnStarts: number;
    turnEnds: number;
    /** 按事件类型计数（截取前 20 类，防输出膨胀）。 */
    typeCounts: Record<string, number>;
    /** 是否因资源上限提前停止（事件/解压字节超限）。 */
    truncated: boolean;
}
export type DeepResult = {
    status: 'ok';
    headerValid: boolean;
    events: DeepEventStats;
    interruptedTurns: number;
} | {
    status: 'decoder-unavailable';
} | {
    status: 'missing';
} | {
    status: 'read-error';
    message: string;
} | {
    status: 'decode-error';
    message: string;
} | {
    status: 'too-large';
    bytes: number;
};
/** 压缩文件上限：超过则跳过 deep（只做帧级）。 */
export declare const MAX_DEEP_COMPRESSED_BYTES: number;
/** 解压总字节上限（达到即停止解码）。 */
export declare const MAX_DEEP_DECOMPRESSED_BYTES: number;
/** 事件数上限（达到即停止解码）。 */
export declare const MAX_DEEP_EVENTS = 200000;
/**
 * 深度分析：流式解码全部帧并统计事件。
 * 任何失败返回带稳定 code 的结果（见 DeepResult），绝不 throw。
 */
export declare function deepAnalyze(path: string): Promise<DeepResult>;

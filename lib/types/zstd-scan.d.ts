/**
 * zstd 帧边界扫描器 —— 零依赖（DataView 读字节），RFC 8878 帧结构对齐官方
 * `scanZstdFrames`（只解析 frame header + block header，不解码 block 数据）。
 *
 * 用途：会话健康检查的帧级诊断（torn/损坏/帧数统计）。
 * 与官方的差异：官方对非法结构 throw；本工具返回结构化错误码（诊断用途）。
 */
export interface FrameScanResult {
    /** 完整帧数量。 */
    frames: number;
    /** 每帧 [start, end) 偏移。 */
    offsets: Array<[number, number]>;
    /** 尾部不完整数据起始偏移（torn 检测；无则 undefined）。 */
    tornStart: number | undefined;
    error: 'not-zstd' | 'invalid-magic' | 'reserved-header' | 'reserved-block' | 'truncated' | undefined;
}
/**
 * 扫描一个文件的所有 zstd 帧边界；不解码帧内容。
 * 空输入（0 字节）返回 error: 'not-zstd'（调用方按 empty 归类）。
 * 审查 SH-03 修复：**每一帧开头都校验 magic**——后续帧坏 magic 报
 * 'invalid-magic'（带损坏偏移 tornStart），不再把垃圾误计为完整帧。
 */
export declare function scanZstdFrames(buf: Uint8Array, maxFrames?: number): FrameScanResult;

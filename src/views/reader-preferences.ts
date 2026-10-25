/** 阅读弹窗宽度沿用像素单位，小窗口仍由 CSS 限制溢出。 */
export const DEFAULT_READER_WIDTH = 720;
export const MIN_READER_WIDTH = 480;
export const MAX_READER_WIDTH = 1000;
export function readerWidth(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_READER_WIDTH;
    return Math.min(MAX_READER_WIDTH, Math.max(MIN_READER_WIDTH, Math.round(value)));
}

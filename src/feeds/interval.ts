/** 小时输入换算为整分钟，兼容已有的分钟存储。 */
export function intervalMinutes(value: string, minimum = 5, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!value.trim()) throw new Error('请输入刷新间隔');
    const minutes = Number(value) * 60;
    if (!Number.isFinite(minutes) || Math.abs(minutes - Math.round(minutes)) > 0.000001 || Math.round(minutes) < minimum || Math.round(minutes) > maximum)
        throw new Error(minimum === 60 ? '间隔须为 1～24 小时，且精确到整分钟' : '间隔至少 5 分钟，且精确到整分钟');
    return Math.round(minutes);
}
export function intervalHours(minutes: number): string { return String(Number((minutes / 60).toFixed(10))); }
export function nextRefresh(at?: number, retry = false): string {
    return at ? `${retry ? '下次重试' : '下次刷新'}：${new Date(at).toLocaleString()}` : '下次刷新：待安排';
}

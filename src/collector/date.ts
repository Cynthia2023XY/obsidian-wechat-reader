/** 仅将带时区的有效日期视为可信发布时间，避免含糊日期误触发已读或清理。 */
export function publishedTime(value: string | null | undefined): number | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
    // 验证年月日真实存在，Date.parse 会将部分非法日期自动归一化。
    const day = value.slice(0, 10);
    // 拆分日期以校验闰年和每月天数。
    const [year, month, date] = day.split('-').map(Number);
    // 使用 UTC 日历验证年月日组合。
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, date); calendar.setUTCHours(0, 0, 0, 0);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return undefined;
    // 不合法时间或时区均保持未读及不可清理。
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

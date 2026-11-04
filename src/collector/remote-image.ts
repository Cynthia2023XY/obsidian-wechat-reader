/** 微信正文图片只允许无凭据的 HTTPS CDN 地址。 */
export function wechatImageUrl(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)(qpic|qlogo)\.cn$/.test(url.hostname)) return;
    return url.href;
  } catch { return; }
}

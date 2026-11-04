import { describe, it, expect } from 'vitest';
import { wechatImageUrl } from '../src/collector/remote-image';
describe('微信图片远程地址', () => {
 it('只接受无凭据的微信 HTTPS CDN', () => {
  expect(wechatImageUrl('https://mmbiz.qpic.cn/a?wx_fmt=png')).toBe('https://mmbiz.qpic.cn/a?wx_fmt=png');
  for (const value of ['http://mmbiz.qpic.cn/a','https://qpic.cn.evil.com/a','https://user@qpic.cn/a','https://qpic.cn:123/a','file:///tmp/a','asset:id']) expect(wechatImageUrl(value)).toBeUndefined();
 });
});

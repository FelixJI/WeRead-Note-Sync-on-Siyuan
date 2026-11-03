// 唯一允许外联的远端地址（冻结契约）：精确字符串匹配，不做任何解析归一，
// 避免 URL 解析差异（大小写、userinfo、尾斜杠等）被用来绕过白名单。

export const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";

export function assertWhitelistedUrl(url: string): void {
    if (url !== WEREAD_GATEWAY_URL) {
        throw new Error(`URL 不在白名单内，已拒绝请求：${url}`);
    }
}

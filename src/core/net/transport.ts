// 传输层抽象：实现者只需给出"文本响应的 HTTP POST"，
// 上层（微信读书网关客户端）不关心底层是浏览器 fetch 还是内核 forwardProxy。

export interface HttpTextResponse {
    status: number;
    body: string;
    contentType?: string;
}

export interface Transport {
    post(
        url: string,
        body: unknown,
        headers: Record<string, string>,
        timeoutMs: number,
    ): Promise<HttpTextResponse>;
}

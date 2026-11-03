// T03 设计契约 §1（docs/design/t03-diff-review.md）：纯函数 diff 层。
// 公共前后缀修剪 → 中段 LCS（O(n·m)，句子级文本可接受）；输出相邻同类型合并、
// equal/insert/delete 交替、相同两串 → 单个 equal。
// 字符串按 Unicode 码点切分（Array.from，代理对/ZWJ emoji 不拆半）；
// 行级 diff 按行切分且行尾符（\n / \r\n）保留在行文本内。
// 无随机性：CRLF/空串/纯空白/Unicode 输入均确定。

export interface DiffOp {
    type: "equal" | "insert" | "delete";
    text: string;
}

type OpType = DiffOp["type"];

/** 中间结构：同类型项边产出边累积，避免产生相邻同类型 op。 */
interface MutableOp {
    type: OpType;
    items: string[];
}

function pushOp(ops: MutableOp[], type: OpType, item: string): void {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === type) {
        last.items.push(item);
    } else {
        ops.push({ type, items: [item] });
    }
}

/** 中段最长公共子序列（逐项全等比较；O(n·m) DP + 回溯）。 */
function longestCommonSubsequence(
    aItems: readonly string[],
    bItems: readonly string[],
): string[] {
    const n = aItems.length;
    const m = bItems.length;
    if (n === 0 || m === 0) {
        return [];
    }
    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (aItems[i - 1] === bItems[j - 1]) {
                dp[i * width + j] = dp[(i - 1) * width + (j - 1)] + 1;
            } else {
                const up = dp[(i - 1) * width + j];
                const left = dp[i * width + (j - 1)];
                dp[i * width + j] = up >= left ? up : left;
            }
        }
    }
    const seq: string[] = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (aItems[i - 1] === bItems[j - 1]) {
            seq.push(aItems[i - 1]!);
            i -= 1;
            j -= 1;
        } else if (dp[(i - 1) * width + j] >= dp[i * width + (j - 1)]) {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    seq.reverse();
    return seq;
}

/**
 * 通用序列 diff：先修剪公共前后缀（后缀不得越过前缀，避免同一项被重复消费），
 * 再对中段做 LCS 对齐。LCS 贪心展开对任意公共子序列均正确：
 * 未对齐的 a 侧项记 delete、b 侧项记 insert，两侧均未对齐时先 delete 后 insert。
 */
function diffSequences(aItems: readonly string[], bItems: readonly string[]): DiffOp[] {
    const ops: MutableOp[] = [];
    const n = aItems.length;
    const m = bItems.length;

    let prefix = 0;
    while (prefix < n && prefix < m && aItems[prefix] === bItems[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < n - prefix &&
        suffix < m - prefix &&
        aItems[n - 1 - suffix] === bItems[m - 1 - suffix]
    ) {
        suffix += 1;
    }

    for (let idx = 0; idx < prefix; idx++) {
        pushOp(ops, "equal", aItems[idx]!);
    }

    const aMid = aItems.slice(prefix, n - suffix);
    const bMid = bItems.slice(prefix, m - suffix);
    const lcs = longestCommonSubsequence(aMid, bMid);
    let i = 0;
    let j = 0;
    let k = 0;
    while (k < lcs.length) {
        const unit = lcs[k]!;
        if (aMid[i] === unit && bMid[j] === unit) {
            pushOp(ops, "equal", unit);
            i += 1;
            j += 1;
            k += 1;
        } else if (aMid[i] === unit) {
            // a 侧当前项即对齐项，b 侧当前项未对齐 → 插入
            pushOp(ops, "insert", bMid[j]!);
            j += 1;
        } else {
            // a 侧当前项未对齐（b 侧是否对齐都不影响）：先删除，保证删除先于插入
            pushOp(ops, "delete", aMid[i]!);
            i += 1;
        }
    }
    while (i < aMid.length) {
        pushOp(ops, "delete", aMid[i]!);
        i += 1;
    }
    while (j < bMid.length) {
        pushOp(ops, "insert", bMid[j]!);
        j += 1;
    }
    for (let idx = n - suffix; idx < n; idx++) {
        pushOp(ops, "equal", aItems[idx]!);
    }

    return ops.map((op) => ({ type: op.type, text: op.items.join("") }));
}

/** 按 Unicode 码点切分（Array.from 迭代码点：代理对/emoji 组合不拆半）。 */
export function diffChars(a: string, b: string): DiffOp[] {
    return diffSequences(Array.from(a), Array.from(b));
}

/** 按行切分，行尾符（\n，含 CRLF 的 \r\n）保留在行文本内；空串 → 无行。 */
function splitLines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** 行级 diff：同算法作用于行单元（单行内字符级 diff 由 UI 层按需调用 diffChars）。 */
export function diffLines(a: string, b: string): DiffOp[] {
    return diffSequences(splitLines(a), splitLines(b));
}

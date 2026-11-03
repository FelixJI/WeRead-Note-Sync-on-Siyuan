/**
 * T06 打包：dist → package.zip（思源插件安装包）。
 * 审阅整改 M3：零依赖纯 Node ZIP 写入（STORE 不压缩）——
 * PS5.1 的 Compress-Archive 与 .NET Framework ZipFile 均会写反斜杠条目名（非 Windows 内核解包 i18n 损坏），
 * 本实现条目名恒为正斜杠；打包后自校验（条目名/七件套/CRC）。不发布（发布需另行授权）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("dist");
const out = resolve("package.zip");

function* walk(dir, prefix = "") {
    for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        const rel = prefix === "" ? name : `${prefix}/${name}`;
        if (statSync(full).isDirectory()) {
            yield* walk(full, rel);
        } else {
            yield { rel, full };
        }
    }
}

const REQUIRED = ["index.js", "index.css", "plugin.json", "icon.png", "README.md", "i18n/zh-CN.json", "i18n/en.json"];
const files = [...walk(dist)];
const names = new Set(files.map((f) => f.rel));
const missing = REQUIRED.filter((f) => !names.has(f));
if (missing.length > 0) {
    console.error(`dist 缺少必需产物：${missing.join(", ")}；先运行 npm run build`);
    process.exit(1);
}

// ---- 最小 ZIP（STORE）----
const enc = new TextEncoder();
const chunks = [];
const central = [];
let offset = 0;
const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) {
        c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
const dosTime = ((d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff)(new Date());
const dosDate = ((d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff)(new Date());
for (const f of files) {
    const data = readFileSync(f.full);
    const nameBytes = enc.encode(f.rel);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, Buffer.from(nameBytes), data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
}
const centralStart = offset;
for (const e of central) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.size, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.nameBytes.length, 28);
    c.writeUInt32LE(e.offset, 42);
    chunks.push(c, Buffer.from(e.nameBytes));
    offset += c.length + e.nameBytes.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(offset - centralStart, 12);
end.writeUInt32LE(centralStart, 16);
chunks.push(end);

// 写文件（跨平台，无 shell）
import("node:fs").then(async (fsMod) => {
    await fsMod.promises.writeFile(out, Buffer.concat(chunks));
    // 自校验：重读并断言条目名无反斜杠、七件套齐全
    const check = execFileSync(process.execPath, ["-e", `
        const {readFileSync} = require("fs");
        const buf = readFileSync("package.zip");
        const names = [];
        for (let i = 0; i < buf.length - 4; i += 1) {
            if (buf.readUInt32LE(i) === 0x02014b50) {
                const nlen = buf.readUInt16LE(i + 28);
                names.push(buf.toString("utf8", i + 46, i + 46 + nlen));
            }
        }
        if (names.some((n) => n.includes(String.fromCharCode(92)))) { console.error("FAIL: backslash entry"); process.exit(1); }
        console.log("zip 校验通过：" + names.length + " 条（含 " + names.filter(n=>n.startsWith("i18n/")).length + " 个 i18n 条目）");
    `], { stdio: "inherit" });
    void check;
    console.log("package.zip 生成完成（发布需另行授权，本脚本不发布）");
});

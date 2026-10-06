// 零依赖 zip 写出（store-only，不压缩；EDITOR-PLAN §3A.4 的通用保存回退）。
// 壁纸资源多是已压缩的 .tex / 图片 / 视频，再 deflate 收益很小，不值得引库。
// 不支持 ZIP64：单文件或总量超过 4 GiB、条目超过 65535 直接报错。

export type ZipEntry = { path: string; data: Uint8Array };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间戳（zip 头要求），按本地时间 */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const LIMIT = 0xffffffff;

export function buildZip(entries: ZipEntry[], now = new Date()): Blob {
  const enc = new TextEncoder();
  const { time, date } = dosTime(now);
  if (entries.length > 0xffff) throw new Error("zip 条目超过 65535（未实现 ZIP64）");
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const size = e.data.length;
    if (size >= LIMIT || offset >= LIMIT) throw new Error("zip 超过 4 GiB（未实现 ZIP64）");
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    // bit 11：文件名是 UTF-8（中文路径在解压端不乱码）
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    parts.push(local, e.data as Uint8Array<ArrayBuffer>);
    offset += local.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  if (offset + cdSize >= LIMIT) throw new Error("zip 超过 4 GiB（未实现 ZIP64）");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

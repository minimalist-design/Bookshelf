import { inflateSync } from "fflate";

/** Minimal random-access ZIP reader: parses the central directory and inflates single entries on demand. */

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_U32 = 0xffffffff;

const utf8 = new TextDecoder("utf-8");
const latin1 = new TextDecoder("latin1");

async function readRange(path: string, start: number, end: number): Promise<DataView> {
  const bytes = await Bun.file(path).slice(start, end).bytes();
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true));
}

export class ZipArchive {
  private constructor(
    readonly path: string,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const size = Bun.file(path).size;
    if (size < 22) throw new ZipError("Not a ZIP file");
    const tailLen = Math.min(size, 22 + 0xffff + 20);
    const tail = await readRange(path, size - tailLen, size);

    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("ZIP end of central directory not found");

    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);

    if (cdOffset === MAX_U32 || cdSize === MAX_U32 || count === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) throw new ZipError("ZIP64 locator missing");
      const z64Offset = u64(tail, loc + 8);
      const z64 = await readRange(path, z64Offset, z64Offset + 56);
      if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new ZipError("ZIP64 end of central directory missing");
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (cdOffset + cdSize > size) throw new ZipError("Corrupt ZIP central directory");

    const cd = await readRange(path, cdOffset, cdOffset + cdSize);
    const bytes = new Uint8Array(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== CD_SIG) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let compressedSize = cd.getUint32(p + 20, true);
      let uncompressedSize = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let localHeaderOffset = cd.getUint32(p + 42, true);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800 ? utf8 : tryUtf8(nameBytes) ? utf8 : latin1).decode(nameBytes);

      // ZIP64 extended information extra field.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.getUint16(e, true);
        const len = cd.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === MAX_U32) (uncompressedSize = u64(cd, q)), (q += 8);
          if (compressedSize === MAX_U32) (compressedSize = u64(cd, q)), (q += 8);
          if (localHeaderOffset === MAX_U32) localHeaderOffset = u64(cd, q);
        }
        e += 4 + len;
      }
      entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
      p = extraEnd + commentLen;
    }
    return new ZipArchive(path, entries);
  }

  /** Case-insensitive lookup by exact path. */
  find(name: string): ZipEntry | undefined {
    const lower = name.toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === lower);
  }

  async read(entry: ZipEntry, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
    if (entry.flags & 0x1) throw new ZipError(`Encrypted ZIP entry: ${entry.name}`);
    if (entry.uncompressedSize > maxBytes) throw new ZipError(`ZIP entry too large: ${entry.name}`);
    const local = await readRange(this.path, entry.localHeaderOffset, entry.localHeaderOffset + 30);
    if (local.getUint32(0, true) !== LOCAL_SIG) throw new ZipError(`Bad local header: ${entry.name}`);
    const dataStart = entry.localHeaderOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const data = await Bun.file(this.path).slice(dataStart, dataStart + entry.compressedSize).bytes();
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.uncompressedSize) });
    throw new ZipError(`Unsupported ZIP compression method ${entry.method}: ${entry.name}`);
  }

  async readText(name: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
    const entry = this.find(name);
    return entry ? utf8.decode(await this.read(entry, maxBytes)) : null;
  }
}

function tryUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when the file starts with a ZIP local header (CBR files are sometimes renamed ZIPs). */
export async function isZipFile(path: string): Promise<boolean> {
  const head = await Bun.file(path).slice(0, 4).bytes();
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * Minimal ZIP reader for tests. Deliberately written independently of
 * `data/zip.ts` (bitwise CRC instead of a lookup table, reads the archive
 * through the central directory), so that it can't share its bugs.
 */

export type ZipFile = {
  name: string;
  data: Uint8Array<ArrayBuffer>;
};

const bitwiseCrc32 = (data: Uint8Array) => {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ~crc >>> 0;
};

const decodeUtf8 = (bytes: Uint8Array) =>
  decodeURIComponent(
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(
      "",
    ),
  );

/** throws if the archive is malformed in any way we know how to check */
export const readZip = (archive: Uint8Array): ZipFile[] => {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );

  const assert = (condition: boolean, message: string) => {
    if (!condition) {
      throw new Error(`Invalid ZIP archive: ${message}`);
    }
  };

  // end of central directory record (we never write an archive comment, so
  // it's always the last 22 bytes)
  const eocd = archive.length - 22;
  assert(eocd >= 0, "too short");
  assert(view.getUint32(eocd, true) === 0x06054b50, "EOCD signature");
  const count = view.getUint16(eocd + 10, true);
  assert(view.getUint16(eocd + 8, true) === count, "entry counts differ");
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  assert(directoryOffset + directorySize === eocd, "central directory size");

  const files: ZipFile[] = [];
  let offset = directoryOffset;
  let expectedLocalOffset = 0;

  for (let index = 0; index < count; index++) {
    assert(view.getUint32(offset, true) === 0x02014b50, "directory signature");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeUtf8(nameBytes);

    assert(method === 0, `${name}: expected STORE method`);
    assert((flags & 0x0800) !== 0, `${name}: UTF-8 flag not set`);
    assert(compressedSize === size, `${name}: sizes differ`);
    assert(localOffset === expectedLocalOffset, `${name}: local offset`);

    // local file header must agree with the central directory
    assert(
      view.getUint32(localOffset, true) === 0x04034b50,
      `${name}: local signature`,
    );
    assert(view.getUint32(localOffset + 14, true) === crc, `${name}: crc`);
    assert(view.getUint32(localOffset + 18, true) === size, `${name}: size`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    assert(localNameLength === nameLength, `${name}: name length`);
    assert(
      decodeUtf8(
        archive.subarray(localOffset + 30, localOffset + 30 + nameLength),
      ) === name,
      `${name}: local name`,
    );

    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert(dataOffset + size <= directoryOffset, `${name}: truncated`);
    const data = new Uint8Array(size);
    data.set(archive.subarray(dataOffset, dataOffset + size));
    assert(bitwiseCrc32(data) === crc, `${name}: checksum mismatch`);

    files.push({ name, data });
    expectedLocalOffset = dataOffset + size;
    offset += 46 + nameLength + extraLength + commentLength;
  }

  assert(expectedLocalOffset === directoryOffset, "gap before the directory");
  assert(offset === eocd, "central directory length");

  return files;
};

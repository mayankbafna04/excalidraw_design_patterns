/**
 * Minimal ZIP archive writer.
 *
 * Entries are stored uncompressed ("STORE" method): the only thing we archive
 * are PNG files, which are already compressed, so deflating them again would
 * cost time for no gain. That also keeps the writer small enough to not need
 * a dependency.
 *
 * Not supported (not needed): compression, ZIP64 (archives over 4 GB or more
 * than 65535 entries), encryption, directories.
 */

export type ZipEntry = {
  /** filename inside of the archive */
  name: string;
  data: Uint8Array;
};

const SIGNATURE = {
  localFileHeader: 0x04034b50,
  centralDirectoryHeader: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
} as const;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

/** ZIP specification version 2.0 */
const ZIP_VERSION = 20;
/** general purpose bit 11: filenames are encoded as UTF-8 */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** MS-DOS date & time format used by ZIP (2s resolution, starts at 1980) */
const toDosDateTime = (date: Date) => {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

/**
 * Packs the entries into a ZIP archive, in the supplied order.
 *
 * @param modifiedAt modification time stamped on every entry
 */
export const createZip = (
  entries: readonly ZipEntry[],
  modifiedAt: Date = new Date(),
): Uint8Array<ArrayBuffer> => {
  if (entries.length > MAX_UINT16) {
    throw new Error("Too many files to create a ZIP archive");
  }

  const names = new Set<string>();
  const encoder = new TextEncoder();
  const { time, date } = toDosDateTime(modifiedAt);

  const files = entries.map((entry) => {
    if (names.has(entry.name)) {
      throw new Error(`Duplicate filename in a ZIP archive: "${entry.name}"`);
    }
    names.add(entry.name);

    return {
      name: encoder.encode(entry.name),
      data: entry.data,
      crc: crc32(entry.data),
    };
  });

  const filesSize = files.reduce(
    (size, file) =>
      size + LOCAL_FILE_HEADER_SIZE + file.name.length + file.data.length,
    0,
  );
  const centralDirectorySize = files.reduce(
    (size, file) => size + CENTRAL_DIRECTORY_HEADER_SIZE + file.name.length,
    0,
  );
  const totalSize =
    filesSize + centralDirectorySize + END_OF_CENTRAL_DIRECTORY_SIZE;

  if (totalSize > MAX_UINT32) {
    throw new Error("Files are too big to create a ZIP archive");
  }

  const archive = new Uint8Array(totalSize);
  const view = new DataView(archive.buffer);

  let offset = 0;
  const offsets: number[] = [];

  // file entries
  // ---------------------------------------------------------------------------
  for (const file of files) {
    offsets.push(offset);

    view.setUint32(offset, SIGNATURE.localFileHeader, true);
    view.setUint16(offset + 4, ZIP_VERSION, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, METHOD_STORE, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, file.crc, true);
    // compressed & uncompressed size are the same since we're not compressing
    view.setUint32(offset + 18, file.data.length, true);
    view.setUint32(offset + 22, file.data.length, true);
    view.setUint16(offset + 26, file.name.length, true);
    // extra field length
    view.setUint16(offset + 28, 0, true);
    offset += LOCAL_FILE_HEADER_SIZE;

    archive.set(file.name, offset);
    offset += file.name.length;

    archive.set(file.data, offset);
    offset += file.data.length;
  }

  // central directory
  // ---------------------------------------------------------------------------
  const centralDirectoryOffset = offset;

  files.forEach((file, index) => {
    view.setUint32(offset, SIGNATURE.centralDirectoryHeader, true);
    // version made by
    view.setUint16(offset + 4, ZIP_VERSION, true);
    // version needed to extract
    view.setUint16(offset + 6, ZIP_VERSION, true);
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, METHOD_STORE, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.data.length, true);
    view.setUint32(offset + 24, file.data.length, true);
    view.setUint16(offset + 28, file.name.length, true);
    // extra field length, comment length, disk number, internal attributes
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    // external attributes
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, offsets[index], true);
    offset += CENTRAL_DIRECTORY_HEADER_SIZE;

    archive.set(file.name, offset);
    offset += file.name.length;
  });

  // end of central directory
  // ---------------------------------------------------------------------------
  view.setUint32(offset, SIGNATURE.endOfCentralDirectory, true);
  // number of this disk, disk where central directory starts
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  // number of entries on this disk, total number of entries
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, centralDirectorySize, true);
  view.setUint32(offset + 16, centralDirectoryOffset, true);
  // comment length
  view.setUint16(offset + 20, 0, true);

  return archive;
};

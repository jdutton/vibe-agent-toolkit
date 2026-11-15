/**
 * Archive normalisation for fault-matrix snapshots: a ZIP's entry times are the clock of the run
 * that wrote it, not its content.
 *
 * Pure: bytes in, bytes out.
 */

/** The ZIP central directory's end record, and the two headers that carry each entry's DOS time and date. */
const ZIP_END_OF_DIRECTORY = 0x06_05_4b_50;
const ZIP_CENTRAL_HEADER = 0x02_01_4b_50;
const ZIP_LOCAL_HEADER = 0x04_03_4b_50;
const ZIP_END_RECORD_SIZE = 22;
const ZIP_CENTRAL_HEADER_SIZE = 46;

/**
 * A ZIP with every entry's modification time and date zeroed, in the central directory and in each
 * local header. The packager zips files it has just written, so their times are the run's clock:
 * two runs differ there and nowhere else. Anything that is not a whole archive (truncated by a
 * refused write, a fixture's stand-in) comes back unchanged, so it still differs from GOLDEN.
 */
export function zipWithoutEntryTimes(bytes: Buffer): Buffer {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + ZIP_END_RECORD_SIZE > bytes.length || bytes.readUInt32LE(end) !== ZIP_END_OF_DIRECTORY) return bytes;
  const out = Buffer.from(bytes);
  let at = out.readUInt32LE(end + 16);
  for (let entry = out.readUInt16LE(end + 10); entry > 0; entry--) {
    if (at + ZIP_CENTRAL_HEADER_SIZE > out.length || out.readUInt32LE(at) !== ZIP_CENTRAL_HEADER) return bytes;
    const local = out.readUInt32LE(at + 42);
    if (local + 14 > out.length || out.readUInt32LE(local) !== ZIP_LOCAL_HEADER) return bytes;
    out.writeUInt32LE(0, at + 12);
    out.writeUInt32LE(0, local + 10);
    at += ZIP_CENTRAL_HEADER_SIZE + out.readUInt16LE(at + 28) + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

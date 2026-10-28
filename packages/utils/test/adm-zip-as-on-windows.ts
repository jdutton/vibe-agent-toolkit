/**
 * The ZIP library as it behaves on Windows, for a macOS or Linux run: every entry it builds says
 * "made on Windows" (host 10, NTFS), which is the one byte a round-trip here cannot otherwise show.
 *
 * Only the stamp changes — every method, the folder walk included, is the library's own, reaching
 * `addFile` through the instance. Handed to `vi.mock('adm-zip', …)` from the mock's factory.
 */

/** `version made by` as the ZIP library writes it on Windows: host 10 (NTFS), spec 2.0. */
export const MADE_ON_WINDOWS = 0x0a_14;

type Stamped = { header: { made: number } };
type Zip = { addFile(...args: unknown[]): Stamped };

/**
 * The `adm-zip` module, its factory wrapped to stamp {@link MADE_ON_WINDOWS} on every entry.
 *
 * @param importOriginal - The `vi.mock` factory's own loader of the real module
 * @returns The module to mock `adm-zip` with
 */
export async function admZipAsOnWindows(importOriginal: <T>() => Promise<T>): Promise<{ default: (...args: unknown[]) => Zip }> {
  const { default: realZip } = await importOriginal<{ default: (...args: unknown[]) => Zip }>();
  // The library's export is a factory returning a plain object, so its methods are wrapped on the instance.
  function zipAsOnWindows(...args: unknown[]): Zip {
    const zip = realZip(...args);
    const addFile = zip.addFile.bind(zip);
    zip.addFile = (...fileArgs: unknown[]): Stamped => {
      const entry = addFile(...fileArgs);
      entry.header.made = MADE_ON_WINDOWS;
      return entry;
    };
    return zip;
  }
  return { default: zipAsOnWindows };
}

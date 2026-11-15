import { Capacitor } from '@capacitor/core';

// Hand a generated file (an export, a backup, card art) to the user.
//
// In a browser that is a download link. The app's WebView has no download
// manager to receive one, so a link there does nothing at all; instead the file
// is written to the app's cache and offered through the system share sheet, from
// which it can be saved to Files or Drive, mailed, or sent to a computer. That
// matters most in device mode, where an export is the only copy of a collection
// that exists anywhere but this phone.
//
// Every blob download in the app goes through here (saveFile.test.js checks
// that no component builds its own).

export const saveStrategy = ({ native }) => (native ? 'native' : 'web');

// Path separators would make Filesystem write into a subdirectory that does not
// exist; everything else is kept so the shared file has the name it would have
// had as a download.
export const safeFileName = (name) => String(name).replace(/[\\/:*?"<>|]+/g, '_') || 'bindarr-export';

function webDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Not revoked synchronously: some browsers start the download after click()
  // returns, and a revoked URL then saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// The bridge to the native file system carries strings, so binary goes across as
// base64. A whole full backup in one call (tens of MB in device mode) meant one
// giant data-URL string plus the copies the bridge makes of it; written in
// slices instead, only one slice is ever in flight (MOB-07). A multiple of 3
// bytes, so no slice's base64 ends in padding.
export const CHUNK_BYTES = 3 * 512 * 1024;

export function bytesToBase64(bytes) {
  let binary = '';
  // fromCharCode takes its bytes as arguments; a few thousand at a time stays
  // well inside every engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

// Shared files live in their own folder of the app's cache, so the next export
// can clear out whatever an earlier one left behind.
const EXPORT_DIR = 'exports';

// How long a shared file stays after the share sheet closes. The sheet returns
// once a target is picked, and on Android that app may still be reading the file;
// it is gone by the next export at the latest either way.
export const KEEP_SHARED_MS = 2 * 60 * 1000;

// Write the blob in slices, share it, then remove it. fs is @capacitor/filesystem
// ({ Filesystem, Directory }), share is @capacitor/share's Share: passed in, so
// the slicing and the clean-up are testable without a phone.
export async function writeAndShare(blob, filename, { fs, share, later = setTimeout }) {
  const { Filesystem, Directory } = fs;
  const dir = { directory: Directory.Cache };
  // Whatever an earlier export left (an app killed before its clean-up ran).
  await Filesystem.rmdir({ path: EXPORT_DIR, ...dir, recursive: true }).catch(() => {});
  await Filesystem.mkdir({ path: EXPORT_DIR, ...dir, recursive: true }).catch(() => {});
  const path = `${EXPORT_DIR}/${safeFileName(filename)}`;
  const remove = () => Filesystem.deleteFile({ path, ...dir }).catch(() => {});
  let uri;
  try {
    const slices = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
    for (let i = 0; i < slices; i++) {
      const data = bytesToBase64(new Uint8Array(await blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer()));
      if (i === 0) ({ uri } = await Filesystem.writeFile({ path, data, ...dir }));
      else await Filesystem.appendFile({ path, data, ...dir });
    }
  } catch (err) {
    await remove();
    throw err;
  }
  try {
    await share.share({ title: filename, url: uri, dialogTitle: filename });
  } catch (err) {
    // Closing the share sheet without picking a target is a choice, not a failure.
    if (!/cancel/i.test(err && err.message)) {
      await remove();
      throw err;
    }
    await remove();
    return;
  }
  later(remove, KEEP_SHARED_MS);
}

async function nativeShare(blob, filename) {
  const [fs, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  return writeAndShare(blob, filename, { fs, share: Share });
}

export async function saveFile(blob, filename, {
  native = Capacitor.isNativePlatform(),
  web = webDownload,
  share = nativeShare,
} = {}) {
  return saveStrategy({ native }) === 'native' ? share(blob, filename) : web(blob, filename);
}

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

async function nativeShare(blob, filename) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({ path: safeFileName(filename), data, directory: Directory.Cache });
  try {
    await Share.share({ title: filename, url: uri, dialogTitle: filename });
  } catch (err) {
    // Closing the share sheet without picking a target is a choice, not a failure.
    if (!/cancel/i.test(err && err.message)) throw err;
  }
}

export async function saveFile(blob, filename, {
  native = Capacitor.isNativePlatform(),
  web = webDownload,
  share = nativeShare,
} = {}) {
  return saveStrategy({ native }) === 'native' ? share(blob, filename) : web(blob, filename);
}

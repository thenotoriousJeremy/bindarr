// Camera zoom decisions, kept out of CameraScanner so they can be tested without a
// camera. Units are whatever the camera reports: phones give a ratio (1–8),
// desktop UVC webcams an arbitrary range (0–60).

// The slider range from track.getCapabilities().zoom, or null when the camera
// has no usable zoom (absent, malformed, or a range with nowhere to go).
export function zoomRange(capZoom) {
  if (!capZoom || typeof capZoom.min !== 'number' || typeof capZoom.max !== 'number' || !(capZoom.max > capZoom.min)) return null;
  return { min: capZoom.min, max: capZoom.max, step: capZoom.step || 0.1 };
}

// The zoom to start at: the saved level if this camera can do it, else what the
// camera is currently set to, else its minimum. `restore` says whether the saved
// level has to be applied to the track. A level saved on another camera can be
// out of this one's range, and localStorage can hold anything.
export function initialZoom(range, saved, current) {
  const s = parseFloat(saved);
  if (Number.isFinite(s) && s >= range.min && s <= range.max) return { zoom: s, restore: true };
  return { zoom: typeof current === 'number' ? current : range.min, restore: false };
}

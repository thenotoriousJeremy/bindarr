// The pixels a scan works from: the guide box's region of the camera frame,
// oriented and deskewed, and the card rectified out of it. Moved out of
// CameraScanner unchanged; the guide box's angle and scale, which the component
// holds, are passed in.
import { isNative } from '../../apiBase';
import { getPerspectiveTransform, warpPerspective } from '../../../../shared/imgproc.mjs';
import { CROP_PAD, EMBED_SIZE } from './scanConstants';

// Resolves the landscape-to-portrait camera stream rotation bug on mobile devices.
// Stream orientation rotation applies to mobile devices (iOS/Android) where
// physical camera sensors deliver landscape raw frames while displayed in
// portrait. Desktop webcams deliver unrotated frames matching the screen layout.
// Returns the oriented frame size and a draw that paints the video into that
// oriented space on any context — no intermediate canvas.
export function videoOrientation(video, videoRect) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const streamRatio = videoWidth / videoHeight;
  const visualRatio = videoRect.width / videoRect.height;
  const isMobile = isNative || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const isRotated = isMobile && ((streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0));
  const outW = isRotated ? videoHeight : videoWidth;
  const outH = isRotated ? videoWidth : videoHeight;
  const draw = (ctx) => {
    if (isRotated) {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
    } else {
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    }
  };
  return { width: outW, height: outH, draw };
}

// The guide-box region of the current frame, oriented and deskewed to the box.
//
// ONE implementation, shared by the capture and by the live overlay. The
// overlay's whole value is that it shows what the SCAN will see, so if it
// framed the picture even slightly differently it would be confidently
// misleading — and a preview that lies is worse than none.
//
// `maxW` downscales for the overlay (a detection frame needs far fewer pixels
// than a match does); `target` reuses a canvas rather than allocating one per
// frame, which is what mobile browsers punish by handing back BLANK canvases
// once their per-tab canvas memory is exhausted.
// `square` scales both axes to maxW directly in hardware (384x384), eliminating
// software bilinear resize in the detect worker.
//
// The video is drawn STRAIGHT into the output with orientation and crop folded
// into one transform. It used to be drawn full-resolution into an intermediate
// oriented canvas first — a resize plus a full-frame (often 1080p+) GPU copy on
// EVERY live-detection frame, just to sample a 384x384 crop out of it.
//
// guide: { angle, scale }, the box's rotation (degrees) and pinch scale.
export function buildFramedCanvas(video, guideElement, guide, maxW = 0, target = null, square = false) {
  if (!video?.videoWidth || !guideElement) return null;
  const { angle: guideAngle, scale: guideScale } = guide;
  const videoRect = video.getBoundingClientRect();
  const oc = videoOrientation(video, videoRect);
  const guideRect = guideElement.getBoundingClientRect();
  // Cover-transform mapping from displayed video px to oriented-canvas px
  // (matches object-fit:cover on the preview).
  const k = Math.max(videoRect.width / oc.width, videoRect.height / oc.height);
  const offX = (videoRect.width - oc.width * k) / 2;
  const offY = (videoRect.height - oc.height * k) / 2;
  // Box centre (rotation is about the element centre, so the rotated AABB
  // centre from getBoundingClientRect is still the true centre).
  const cx = ((guideRect.left + guideRect.width / 2) - videoRect.left - offX) / k;
  const cy = ((guideRect.top + guideRect.height / 2) - videoRect.top - offY) / k;
  // offsetWidth/Height are the unscaled layout size; the CSS scale transform
  // does not change them, so fold guideScale in here.
  const fullW = Math.max(1, Math.round((guideElement.offsetWidth * guideScale / k) * (1 + 2 * CROP_PAD)));
  const fullH = Math.max(1, Math.round((guideElement.offsetHeight * guideScale / k) * (1 + 2 * CROP_PAD)));
  const sX = square ? (maxW ? maxW / fullW : 1) : ((maxW && fullW > maxW) ? maxW / fullW : 1);
  const sY = square ? (maxW ? maxW / fullH : 1) : sX;
  const destW = Math.max(1, Math.round(fullW * sX));
  const destH = Math.max(1, Math.round(fullH * sY));

  const canvas = target || document.createElement('canvas');
  // Resizing reallocates the backing store, so only when the size changed —
  // the live loop reuses one canvas at the same size every frame.
  if (canvas.width !== destW || canvas.height !== destH) {
    canvas.width = destW;                     // also resets pixels + transform
    canvas.height = destH;
  }
  const fctx = canvas.getContext('2d');
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, destW, destH);
  // Sample the (possibly rotated, off-centre) box region upright: dest centre
  // maps to the box centre, undo the box rotation, draw the frame. Pixels past
  // the box come through black; the server auto-detects the card inside.
  fctx.scale(sX, sY);
  fctx.translate(fullW / 2, fullH / 2);
  fctx.rotate(-(guideAngle * Math.PI) / 180);
  fctx.translate(-cx, -cy);
  oc.draw(fctx);
  return canvas;
}

// Rectify the card out of a capture, into the square the embedder expects.
//
// Geometry identical to the server's dewarp (cvScan.detectAndDewarp): same
// square, same corner-to-corner mapping. It has to be — milo is measurably
// sensitive to how tight the crop is, so a client crop that framed the card
// differently would quietly cost accuracy rather than fail outright.
//
// `quad` is normalised to the framed canvas in TL,TR,BR,BL order (the worker
// already reorders cornelius's BL,BR,TL,TR). Returns null rather than a bad
// crop if anything about it is off, so the caller uploads the frame instead.
// `scratch` is a ref holding the canvas reused for the output.
export function localDewarp(canvas, quad, scratch) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  try {
    const w = canvas.width, h = canvas.height;
    const src = quad.map(p => ({ x: p.x * w, y: p.y * h }));
    if (src.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    const N = EMBED_SIZE - 1;
    const dst = [{ x: 0, y: 0 }, { x: N, y: 0 }, { x: N, y: N }, { x: 0, y: N }];
    const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const out = warpPerspective(rgba, w, h, getPerspectiveTransform(src, dst), EMBED_SIZE, EMBED_SIZE);
    const c = scratch.current || (scratch.current = document.createElement('canvas'));
    c.width = EMBED_SIZE; c.height = EMBED_SIZE;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out), EMBED_SIZE, EMBED_SIZE), 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  } catch {
    return null;   // any canvas/geometry failure: send the frame instead
  }
}

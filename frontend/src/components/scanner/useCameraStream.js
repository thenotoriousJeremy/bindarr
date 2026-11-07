import { useState, useRef, useEffect } from 'react';
import { zoomRange, initialZoom } from '../../utils/cameraZoom';
import { pickPreferredCamera } from '../../utils/cameraPick';

// The camera: opening it (and picking the right lens), the live stream, and
// what the track can do (torch, exposure, zoom). Moved out of CameraScanner
// unchanged; the component passes `onBeforeOpen` for the scanner state a fresh
// open resets, which used to be the first lines of startCamera.
// deviceId of the lens to scan with (the user's pick, or the main lens the
// heuristic in startCamera moved to). Absent: let facingMode choose.
const CAMERA_KEY = 'scan_camera_id';

const stopTracks = (s) => s?.getTracks().forEach(track => track.stop());

// One place for the stream constraints, so a picked lens gets the same
// resolution and zoom request as the default one.
const openCamera = (deviceId) => navigator.mediaDevices.getUserMedia({
  video: {
    // A picked lens is exact; otherwise use the back camera on phones.
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
    // 1080p, not 720p. The guide box crops to roughly a third of the frame,
    // so 720p delivered a ~250px-wide card to a pipeline whose reference
    // images are 500px — and accuracy falls off a cliff right there.
    // Measured on 100 MTG cards: exact-printing 76.0% at a 250px card,
    // 91.0% at 420px, 90.0% at 800px. `ideal` rather than `min` so a camera
    // that cannot manage it degrades instead of failing getUserMedia.
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // Chrome only reports caps.zoom (and honours zoom constraints) when the
    // stream was requested with it. Browsers that don't know it ignore it.
    zoom: true
  },
  audio: false
});

// Cameras for the lens picker. Never fails the camera open over it: a browser
// without enumerateDevices just gets no picker.
const listVideoInputs = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices?.();
    return (devices || []).filter(d => d.kind === 'videoinput' && d.deviceId);
  } catch (err) {
    console.warn('enumerateDevices failed:', err);
    return [];
  }
};

export function useCameraStream({ showToast, t, onBeforeOpen }) {
  const [stream, setStream] = useState(null);

  // Camera active states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraErrorKey, setCameraErrorKey] = useState('');

  // Torch/Flashlight control
  const [isTorchOn, setIsTorchOn] = useState(false);
  // Manual exposure: caps ({min,max,step}) if the track exposes
  // exposureCompensation, else null (slider hidden). value = current setting.
  const [exposureCaps, setExposureCaps] = useState(null);
  const [exposure, setExposure] = useState(0);
  // Camera zoom: same shape as exposure, from caps.zoom. Hidden when unsupported.
  const [zoomCaps, setZoomCaps] = useState(null);
  const [zoom, setZoom] = useState(1);
  // Every camera the device has (enumerateDevices `videoinput`), for the lens
  // picker. Filled after the first open: labels only exist once permission is
  // granted. The picker stays hidden with fewer than two.
  const [videoInputs, setVideoInputs] = useState([]);
  const switchingCamera = useRef(false); // one lens switch at a time

  const videoRef = useRef(null);
  const streamRef = useRef(null);

  // Keep a ref mirroring the latest stream so the unmount cleanup below (whose
  // closure is fixed from the first render) can always stop the live tracks.
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Clean up camera stream on unmount. `unmounted` lets a camera open that is
  // still in flight (startCamera/switchCamera await getUserMedia, sometimes
  // twice) release the stream it gets instead of leaving the camera on.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // Detect manual-exposure support on the live track. Present on most Android
  // Chrome back cameras; absent on iOS Safari and many desktop webcams (slider
  // then stays hidden). Reads the current value so the slider starts in place.
  // Zoom is detected the same way and restored from the last session: a phone
  // mounted over the cards wants the same framing every time.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.getCapabilities !== 'function') { setExposureCaps(null); setZoomCaps(null); return; }
    const caps = track.getCapabilities();
    const ec = caps.exposureCompensation;
    if (ec && typeof ec.min === 'number' && typeof ec.max === 'number') {
      setExposureCaps({ min: ec.min, max: ec.max, step: ec.step || (ec.max - ec.min) / 100 || 0.1 });
      const cur = track.getSettings?.().exposureCompensation;
      setExposure(typeof cur === 'number' ? cur : 0);
    } else {
      setExposureCaps(null);
    }
    const range = zoomRange(caps.zoom);
    setZoomCaps(range);
    if (range) {
      const { zoom: z, restore } = initialZoom(range, localStorage.getItem('scan_zoom'), track.getSettings?.().zoom);
      setZoom(z);
      if (restore) updateAdvancedConstraints(track, { zoom: z });
    }
  }, [stream]);

  // Bind the camera stream to the video element when both are ready
  useEffect(() => {
    if (cameraActive && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      // Explicitly call play to ensure the stream plays on all mobile browsers
      videoRef.current.play().catch(err => {
        console.error('Error playing video stream:', err);
      });
    }
  }, [cameraActive, stream]);

  const updateAdvancedConstraints = (track, newAdvancedProps) => {
    try {
      const currentConstraints = track.getConstraints();
      let advanced = currentConstraints.advanced ? [...currentConstraints.advanced] : [];
      let advObj = advanced.length > 0 ? { ...advanced[0] } : {};
      
      for (const [key, value] of Object.entries(newAdvancedProps)) {
        if (value === null || value === undefined) {
          delete advObj[key];
        } else {
          advObj[key] = value;
        }
      }
      
      // Apply ONLY the advanced set. Re-sending the top-level resolution
      // constraints (facingMode/width/height) makes many Android Chrome builds
      // reset the track and silently drop torch/focus. applyConstraints leaves
      // any field we don't name untouched, so the resolution stays put.
      track.applyConstraints({
        advanced: [advObj]
      }).catch(err => console.warn('applyConstraints error:', err));
    } catch (e) {
      console.warn('updateAdvancedConstraints error:', e);
    }
  };

  // Torch gets its own path (not the shared merge) so it applies the bare
  // `advanced: [{ torch }]` constraint and surfaces the real reason on-screen —
  // the user can't open a phone console. iOS Safari never reports caps.torch,
  // so those users get a clear "not supported" instead of a dead button.
  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) { showToast(t('scan.errCameraNotReady')); return; }
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (!caps.torch) {
      showToast(t('scan.errNoTorch'));
      return;
    }
    const next = !isTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setIsTorchOn(next);
    } catch (err) {
      showToast(t('scan.errTorch', { error: err.name || err.message || t('scan.unknownError') }));
    }
  };

  // Exposure bias. exposureCompensation is an EV offset on top of continuous
  // auto-exposure; in 'manual' mode the camera drives exposure by exposureTime/ISO
  // and ignores the compensation, so the slider must stay in continuous mode.
  const changeExposure = (val) => {
    setExposure(val);
    const track = stream?.getVideoTracks?.()[0];
    if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: val });
  };

  // Hardware zoom, not a CSS scale: the frames themselves are zoomed, so the
  // guide-box crop maths stays correct and the crop gets more real pixels.
  const changeZoom = (val) => {
    setZoom(val);
    localStorage.setItem('scan_zoom', String(val));
    const track = stream?.getVideoTracks?.()[0];
    if (track) updateAdvancedConstraints(track, { zoom: val });
  };

  const startCamera = async () => {
    onBeforeOpen();
    setCameraErrorKey('');
    // getUserMedia only exists in a secure context. Served over plain HTTP on a
    // LAN address (the usual Docker setup, http://host:3001) navigator.mediaDevices
    // is undefined, and the browser never shows a permission prompt at all — so
    // "check your permissions" sends people hunting for a setting that is fine.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraErrorKey('scan.errCameraInsecure');
      showToast(t('scan.errCameraInsecure', { origin: window.location.origin, port: window.location.port || '80' }));
      return;
    }
    // A retry must release whatever is still open: Android cannot hold two
    // cameras at once, and a second open would fail as NotReadableError.
    stopTracks(streamRef.current);
    try {
      // The lens picked last time (by the user or by the heuristic below). Exact,
      // so the browser can't swap in another lens; a camera that has gone (new
      // phone, cleared site data rotates deviceIds) falls back to the default.
      const saved = localStorage.getItem(CAMERA_KEY);
      let mediaStream = null;
      if (saved) {
        try {
          mediaStream = await openCamera(saved);
        } catch (err) {
          if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
          localStorage.removeItem(CAMERA_KEY);
        }
      }
      const usedSaved = !!mediaStream;
      if (!mediaStream) mediaStream = await openCamera(null);
      if (unmounted.current) { stopTracks(mediaStream); return; }

      const inputs = await listVideoInputs();
      if (unmounted.current) { stopTracks(mediaStream); return; }
      setVideoInputs(inputs);

      // facingMode 'environment' lets the browser open ANY back lens, and on
      // multi-lens Android phones it often opens the macro one, which cannot
      // focus on a card at arm's length. Nothing saved: move to the main lens
      // once, and remember it so the next open goes straight there.
      if (!usedSaved) {
        const track = mediaStream.getVideoTracks()[0];
        const better = pickPreferredCamera(inputs, { deviceId: track?.getSettings?.().deviceId, label: track?.label });
        if (better) {
          stopTracks(mediaStream);
          try {
            mediaStream = await openCamera(better);
            localStorage.setItem(CAMERA_KEY, better);
          } catch (err) {
            console.warn('Preferred camera failed, keeping the default:', err);
            mediaStream = await openCamera(null);
          }
          if (unmounted.current) { stopTracks(mediaStream); return; }
        }
      }

      streamRef.current = mediaStream;
      setIsTorchOn(false);
      setStream(mediaStream);
      setCameraActive(true);
    } catch (err) {
      console.error('Error opening camera:', err);
      setCameraErrorKey('scan.errCameraPermissions');
      showToast(t('scan.errCameraAccess'));
    }
  };

  // Lens picker / quick-switch. The old tracks stop BEFORE the new open (Android
  // cannot hold two cameras), which also turns the torch off — so its state is
  // reset. Zoom and exposure are re-read from the new track by the [stream]
  // effect, which restores the saved zoom when this lens can do it.
  const switchCamera = async (deviceId) => {
    const current = stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    if (!deviceId || deviceId === current || switchingCamera.current) return;
    switchingCamera.current = true;
    stopTracks(streamRef.current);
    setIsTorchOn(false);
    let next = null;
    try {
      next = await openCamera(deviceId);
      localStorage.setItem(CAMERA_KEY, deviceId);
    } catch (err) {
      console.warn('Camera switch failed:', err);
      showToast(t('scan.errCameraSwitch', { error: err?.name || err?.message || t('scan.unknownError') }));
      // Don't leave the preview dead: go back to whatever the browser picks.
      try { next = await openCamera(null); } catch (e) { console.error('Error reopening camera:', e); }
    }
    switchingCamera.current = false;
    if (unmounted.current) { stopTracks(next); return; }
    if (!next) {
      setStream(null);
      setCameraActive(false);
      setCameraErrorKey('scan.errCameraPermissions');
      return;
    }
    streamRef.current = next;
    setStream(next);
  };

  // What the picker calls a camera: its own label, or "Camera N" while labels
  // are withheld (no permission yet) or the device reports none.
  const cameraLabel = (d, i) => d.label || t('scan.cameraN', { n: i + 1 });
  const activeCameraId = stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || '';

  return {
    stream, cameraActive, cameraErrorKey, isTorchOn,
    exposureCaps, exposure, setExposure, zoomCaps, zoom, videoInputs,
    videoRef, updateAdvancedConstraints, toggleTorch, changeExposure, changeZoom,
    startCamera, switchCamera, cameraLabel, activeCameraId,
  };
}

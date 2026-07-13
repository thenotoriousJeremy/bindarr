import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Library, Zap, ZapOff } from 'lucide-react';
import confetti from 'canvas-confetti';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';
// Fixed centered guide box (normalized 0..1). Center the card in it; the crop
// inside is sent to the server embedding matcher.
const DEFAULT_RECT = { x: 0.17, y: 0.06, w: 0.66, h: 0.88 };
// Confidence gates for the server match. When ORB geometric verification ran
// (verified=true), gate on inlier count; otherwise on CLIP cosine similarity.
// Below the gate the scan shows the candidates for manual selection.
const SCAN_MATCH_MIN_SCORE = 0.55;
const SCAN_MATCH_MIN_INLIERS = 12;

function CameraScanner({ onAddSuccess, showToast, setActiveTab }) {

  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanMatches, setScanMatches] = useState([]);
  
  // UX scan history & effects states
  const [recentScans, setRecentScans] = useState([]);
  const [scanFlash, setScanFlash] = useState(null); // 'success', 'error', or null
  
  // Camera active states
  const [cameraActive, setCameraActive] = useState(false);
  const [hasCameraError, setHasCameraError] = useState(false);
  const [autoScan, setAutoScan] = useState(false);
  const [videoRatio, setVideoRatio] = useState(null);
  // Torch/Flashlight control
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [cardLayout, setCardLayout] = useState(() => localStorage.getItem('default_game') === 'mtg' ? 'mtg' : 'modern');
  // Per-set index prep state for MTG set-scoped matching: 'idle'|'building'|'ready'.
  const [setPrep, setSetPrep] = useState('idle');
  // Which game the current layout belongs to. 'mtg' is its own layout; every
  // other layout value is a Pokémon sub-layout.
  const scanGame = cardLayout === 'mtg' ? 'mtg' : 'pokemon';
  // Set code for set-scoped scanning (both games). Persisted per game so
  // switching Pokémon<->MTG restores that game's remembered set.
  const [scanSetCode, setScanSetCodeState] = useState('');
  const setScanSetCode = (v) => { const val = v || ''; setScanSetCodeState(val); localStorage.setItem(`scanner_set_${scanGame}`, val); };
  const [setList, setSetList] = useState([]);        // {id,name,...} for the active game
  const [setSearchOpen, setSetSearchOpen] = useState(false);
  // Code fed to the scanner: pokemontcg.io set id as-is; for MTG the bare
  // Scryfall code (sets.id is stored prefixed as "mtg-<code>").
  const setScanCode = (s) => scanGame === 'mtg' ? (s.ptcgo_code || (s.id || '').replace(/^mtg-/, '')) : s.id;
  const setQuery = scanSetCode.trim().toLowerCase();
  const setSuggestions = setQuery
    ? setList.filter(s => [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase().includes(setQuery))).slice(0, 8)
    : [];

  const [debugHashImg, setDebugHashImg] = useState('');
  const [debugCandidates, setDebugCandidates] = useState([]);
  const [debugScoped, setDebugScoped] = useState(null); // set code if set-scoped, false if global, null if n/a

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const currentScanId = useRef(0);

  const handleCancelScan = () => {
    currentScanId.current += 1;
    setLoading(false);
    setScanStatus('Scan cancelled.');
    setTimeout(() => {
      setScanStatus(prev => prev === 'Scan cancelled.' ? '' : prev);
    }, 2000);
  };

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);

  // Keep a ref mirroring the latest stream so the unmount cleanup below (whose
  // closure is fixed from the first render) can always stop the live tracks.
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Clean up camera stream on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // On game switch: restore that game's remembered set and load its set list
  // (for the search autocomplete).
  useEffect(() => {
    setScanSetCodeState(localStorage.getItem(`scanner_set_${scanGame}`) || '');
    setSetSearchOpen(false);
    fetch(`/api/sets?game=${scanGame}`).then(r => r.ok ? r.json() : []).then(setSetList).catch(() => setSetList([]));
  }, [scanGame]);

  // When a set code is set, build/verify that set's index on the server so scans
  // match within just that set (~300 cards) — accurate and fast. Polls until the
  // one-time build finishes.
  useEffect(() => {
    if (!scanSetCode) { setSetPrep('idle'); return; }
    let cancelled = false, timer;
    const poll = async () => {
      try {
        const r = await fetch('/api/prepare-set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: scanGame, set: scanSetCode }),
        });
        const d = await r.json();
        if (cancelled) return;
        if (d.ready) { setSetPrep('ready'); return; }
        setSetPrep('building');
        timer = setTimeout(poll, 3000);
      } catch { if (!cancelled) setSetPrep('idle'); }
    };
    setSetPrep('building');
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [scanGame, scanSetCode]);

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

  // Auto-Add Countdown Effect
  useEffect(() => {
    let intervalId;
    if (autoAddCountdown !== null && autoAddCountdown > 0) {
      intervalId = setInterval(() => {
        setAutoAddCountdown(prev => prev - 1);
      }, 1000);
    } else if (autoAddCountdown === 0 && autoAddTargetCard) {
      const cardToTrigger = autoAddTargetCard;
      setAutoAddTargetCard(null);
      setAutoAddCountdown(null);
      autoAddCard(cardToTrigger);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddCountdown, autoAddTargetCard]);

  // Auto-capture scheduler: capture frame 3s after previous capture completes
  useEffect(() => {
    let timerId;
    if (cameraActive && autoScan && !isDrawerOpen && !loading && scanMatches.length === 0 && !autoAddTargetCard) {
      timerId = setTimeout(() => {
        handleCapture();
      }, 3000);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard]);

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
    if (!track) { showToast('Camera not ready — start the camera first.'); return; }
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (!caps.torch) {
      showToast('Flashlight not available on this device/browser (iPhone Safari has no web torch).');
      return;
    }
    const next = !isTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setIsTorchOn(next);
    } catch (err) {
      showToast(`Flashlight failed: ${err.name || err.message || 'unknown error'}`);
    }
  };

  const startCamera = async () => {
    setHasCameraError(false);
    setScanMatches([]);
    setScanStatus('');
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
    setVideoRatio(null);
    try {
      const constraints = {
        video: {
          facingMode: 'environment', // Use back camera on phones
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };
      
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      setCameraActive(true);
    } catch (err) {
      console.error('Error opening camera:', err);
      setHasCameraError(true);
      showToast('Camera access denied or unavailable.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track && isTorchOn) {
        updateAdvancedConstraints(track, { torch: false });
      }
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setCameraActive(false);
    setAutoScan(false); // Reset autoScan on camera stop
    setIsTorchOn(false);
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
    setVideoRatio(null);
  };

  const autoAddCard = async (card) => {
    try {
      const autoPrinting = (card.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal';
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: 1,
          condition: 'Near Mint',
          printing: autoPrinting,
          language: 'English',
          // price_trend is whichever finish the TCG API returned first (usually
          // Normal), not necessarily the Holofoil finish just chosen above —
          // resolve against the printing actually being recorded.
          purchase_price: resolveCardPrice(card, autoPrinting),
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(`Added: ${card.name} → ${placementLabel}`);
        } else if (data.container_full) {
          showToast(`Added: ${card.name} — container full, left Unsorted`);
        } else {
          showToast(`Auto-Added: ${card.name} (${card.set_name})`);
        }

        // Append to recent scans history log
        setRecentScans(prev => [{ ...card, placementLabel }, ...prev].slice(0, 10));
        setScanFlash('success');
        setTimeout(() => setScanFlash(null), 1500);

        // Brief confetti blast for ultra-rares
        const rarity = (card.rarity || '').toLowerCase();
        if (rarity.includes('secret') || rarity.includes('ultra') || (card.price_trend || 0) > 15) {
          confetti({ particleCount: 50, spread: 40, origin: { y: 0.8 } });
        }
        
        onAddSuccess(); // Refresh stats
      } else {
        showToast(`Failed to auto-add ${card.name}`);
        setScanFlash('error');
        setTimeout(() => setScanFlash(null), 1500);
      }
    } catch (err) {
      console.error('Auto-add error:', err);
      showToast('Error auto-adding card.');
      setScanFlash('error');
      setTimeout(() => setScanFlash(null), 1500);
    }
  };

  // Resolves the landscape-to-portrait camera stream rotation bug on mobile devices.
  // It creates a canvas matching the visual orientation on the user's screen.
  // Pass maxW to downscale the output (cheap enough to run every frame for the
  // live detection loop); omit it for a full-resolution capture.
  const getOrientedVideoCanvas = (video, maxW = 0) => {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const canvas = document.createElement('canvas');

    const videoRect = video.getBoundingClientRect();
    const streamRatio = videoWidth / videoHeight;
    const visualRatio = videoRect.width / videoRect.height;

    // Detect if browser displays stream rotated relative to raw texture resolution
    // (If stream is landscape but display container is portrait, or vice versa)
    const isRotated = (streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0);

    // Oriented output dimensions, then an optional uniform downscale.
    const outW = isRotated ? videoHeight : videoWidth;
    const outH = isRotated ? videoWidth : videoHeight;
    const scale = (maxW && outW > maxW) ? maxW / outW : 1;
    canvas.width = Math.max(1, Math.round(outW * scale));
    canvas.height = Math.max(1, Math.round(outH * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale); // subsequent coords are in unscaled (oriented) space

    if (isRotated) {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
    } else {
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    }

    return canvas;
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  const applyMatches = async (matches, notFoundMsg, autoSingle = false) => {
    setScanMatches(matches);
    if (matches.length === 0) {
      setScanStatus(notFoundMsg);
      setScanFlash('error');
      setTimeout(() => setScanFlash(null), 1500);
      return;
    }
    setScanStatus(`Found ${matches.length} matching card(s)!`);
    setScanFlash('success');
    setTimeout(() => setScanFlash(null), 1500);
    if (matches.length === 1 && (scanGame !== 'mtg' || autoSingle)) {
      if (autoScan) {
        setAutoAddTargetCard(matches[0]);
        setAutoAddCountdown(2);
        setScanMatches([]);
      } else {
        stopCamera();
        openQuickAdd(matches[0]);
      }
    }
  };

  const handleCapture = async () => {
    if (loading || !videoRef.current || !cameraActive) return;

    setLoading(true);
    const scanId = ++currentScanId.current;
    setScanMatches([]);
    setScanStatus('Initializing scanner...');

    const video = videoRef.current;
    
    const guideElement = document.querySelector('.scan-card-guide');
    if (!guideElement) {
      setLoading(false);
      setScanStatus('Error: Guide box overlay not found.');
      return;
    }

    // 1. Capture and correctly orient the video frame onto a canvas
    const orientedCanvas = getOrientedVideoCanvas(video);

    try {
      // Identify by image (server-side). Send the WHOLE oriented frame (downscaled)
      // so the server can auto-detect + deskew the card before matching — the guide
      // box is just an aim hint.
      {
        setScanStatus('Matching card image...');
        {
          // Downscale the frame for upload; server auto-crops the card. Keep it
          // fairly high-res so a far/small card still has enough pixels to match.
          const up = document.createElement('canvas');
          const s = Math.min(1, 1280 / orientedCanvas.width);
          up.width = Math.round(orientedCanvas.width * s);
          up.height = Math.round(orientedCanvas.height * s);
          up.getContext('2d').drawImage(orientedCanvas, 0, 0, up.width, up.height);
          const imageData = up.toDataURL('image/jpeg', 0.85);
          setDebugHashImg(imageData);
          try {
            const resp = await fetch('/api/scan-match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ game: scanGame, image: imageData, set: scanSetCode }),
            });
            if (scanId !== currentScanId.current) return;
            if (resp.ok) {
              const { game: matchGame, verified, candidates, crop, scoped } = await resp.json();
              console.log('Scan candidates:', matchGame, scoped ? `(set-scoped ${scanSetCode})` : '(GLOBAL)', verified ? 'ORB' : 'CLIP', candidates);
              if (crop) setDebugHashImg(crop); // show the server's auto-cropped card
              setDebugScoped(scoped ? scanSetCode : false);
              setDebugCandidates((candidates || []).map(c => ({ ...c, verified })));
              const top = candidates && candidates[0];
              const confident = top && (verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE);
              if (candidates && candidates.length > 0) {
                if (confident) {
                  // Uses the DETECTED game (auto-detect may override the UI mode).
                  const usedSet = matchGame === scanGame && scanSetCode;
                  const buildParams = (withSet) => {
                    const p = new URLSearchParams({ game: matchGame, prints: '1' });
                    if (top.name) p.append('name', top.name);
                    if (withSet) p.append('set', scanSetCode);
                    return p;
                  };
                  let searchResponse = await fetch(`/api/search?${buildParams(usedSet).toString()}`);
                  if (scanId !== currentScanId.current) return;
                  let matches = searchResponse.ok ? await searchResponse.json() : [];
                  // Set code didn't match this card (wrong box / card not in that
                  // set) — retry across all printings so the user can still pick.
                  if (usedSet && matches.length === 0) {
                    searchResponse = await fetch(`/api/search?${buildParams(false).toString()}`);
                    if (scanId !== currentScanId.current) return;
                    matches = searchResponse.ok ? await searchResponse.json() : [];
                  }
                  // Confident image match: a single result is unambiguous (one
                  // printing, or set code narrowed it), so take the fast path.
                  if (matches.length) { await applyMatches(matches, '', true); return; }
                }

                // If not confident (or multiple printings), fetch full card info for candidates and show the picker.
                setScanStatus('Fetching candidate cards...');
                const fullCandidates = await Promise.all(
                  candidates.slice(0, 8).map(async cand => {
                    const p = new URLSearchParams({ game: matchGame });
                    if (cand.set) p.append('set', cand.set);
                    if (cand.number) p.append('number', cand.number);
                    if (cand.name) p.append('name', cand.name);
                    const res = await fetch(`/api/search?${p.toString()}`);
                    if (res.ok) {
                      const m = await res.json();
                      return m[0]; // Take the closest printing
                    }
                    return null;
                  })
                );
                
                if (scanId !== currentScanId.current) return;
                const validCandidates = fullCandidates.filter(c => c);
                if (validCandidates.length > 0) {
                  await applyMatches(validCandidates, '', false);
                  return;
                }
              }
            }
          } catch (e) { console.warn('scan-match request failed:', e); }
        }
      }

      setScanStatus('No confident match. Try again or search manually.');
      setScanFlash('error');
      setTimeout(() => setScanFlash(null), 1500);
    } catch (err) {
      console.error('Scan match failed:', err);
      if (scanId === currentScanId.current) setScanStatus('Scan failed. Please search manually.');
    } finally {
      if (scanId === currentScanId.current) setLoading(false);
    }
  };

  const openQuickAdd = (card) => {
    setSelectedCard(card);
    setPurchasePrice(0);
    const rarity = (card.rarity || '').toLowerCase();
    if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || rarity.includes('shining')) {
      setPrinting('Holofoil');
    } else {
      setPrinting('Normal');
    }
    setLanguage('English');
    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setScanMatches([]);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage('English');
    setPurchasePrice(0);
    // Restart camera on close if we want to scan another
    startCamera();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(`Added: ${selectedCard.name} → ${placementLabel}`);
        } else if (data.container_full) {
          showToast(`Added: ${selectedCard.name} — container full, left Unsorted`);
        } else {
          showToast(`${selectedCard.name} added to collection!`);
        }

        // Append to recent scans history
        setRecentScans(prev => [{ ...selectedCard, placementLabel }, ...prev].slice(0, 10));

        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess();
        closeDrawer();
      } else {
        showToast('Failed to add card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error saving card.');
    }
  };

  return (
    <div className="scanner-container">



      {/* Camera Window */}
      {!cameraActive ? (
        <div 
          className="camera-preview-wrapper" 
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          onClick={startCamera}
        >
          {hasCameraError ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <AlertTriangle size={48} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                Could not access camera. Please make sure camera permissions are enabled in your browser/phone settings.
              </p>
              <button className="btn btn-primary" onClick={startCamera}>
                <RefreshCw size={14} /> Retry Camera
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Camera size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem', opacity: 0.8 }} />
              <p style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Ready to Scan</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Works best in well-lit environments</p>
              <button className="btn btn-primary">
                Activate Camera
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div
            className="camera-preview-wrapper camera-active"
            style={videoRatio ? { aspectRatio: `${videoRatio}` } : undefined}
          >
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="camera-video"
              onLoadedMetadata={() => {
                const video = videoRef.current;
                if (video) {
                  const isRotated = video.videoWidth > video.videoHeight && video.clientHeight > video.clientWidth;
                  if (isRotated) {
                    setVideoRatio(video.videoHeight / video.videoWidth);
                  } else {
                    setVideoRatio(video.videoWidth / video.videoHeight);
                  }
                }
              }}
            />
            
            {/* Torch Toggle Overlay Button */}
            <button
                type="button"
                className={`btn ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  position: 'absolute',
                  top: '1rem',
                  right: '1rem',
                  zIndex: 20,
                  borderRadius: '50%',
                  padding: '0.6rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}
                onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
              >
                {isTorchOn ? <Zap size={18} /> : <ZapOff size={18} />}
              </button>
            
            {/* Outline Box Guides */}
            <div className="camera-overlay">
              <style>{`
                @keyframes border-flash-success {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--type-grass); box-shadow: 0 0 25px rgba(74, 222, 128, 0.6); }
                }
                @keyframes border-flash-error {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--accent-red); box-shadow: 0 0 25px var(--accent-red-glow); }
                }
              `}</style>
              {(() => { const r = DEFAULT_RECT; return (
              <div
                className="scan-card-guide"
                style={{
                  position: 'absolute',
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  animation: scanFlash === 'success' ? 'border-flash-success 1.5s ease-in-out' : scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {/* Name Guide */}
                <div className="scan-region-title" />

                {/* Left Number Guide. MTG puts the set code + collector number in
                    the bottom-left corner, so its box sits low-left and is taller
                    to catch its two lines. */}
                <div
                  className="scan-region-number-left"
                  style={cardLayout === 'mtg' ? { left: '4%', bottom: '4%', width: '45%', height: '11%' } : {}}
                />

                {loading && <div className="scan-line"></div>}
              </div>
              ); })()}
            </div>
          </div>

          {/* Scanner controls: game + set (needed for matching) and auto-capture. */}
          <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.25rem' }}>
            <div className="sub-nav-tabs" style={{ marginBottom: 0 }}>
              {[['pokemon', 'Pokémon'], ['mtg', 'MTG']].map(([g, label]) => (
                <button
                  key={g}
                  type="button"
                  className={`sub-nav-tab ${scanGame === g ? 'active' : ''}`}
                  style={{ padding: '0.5rem', fontSize: '0.8rem', fontWeight: 700 }}
                  onClick={() => setCardLayout(g === 'mtg' ? 'mtg' : 'modern')}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Set search (both games): pick a set to build a per-set index
                for accurate one-step scans. Free text also works as an
                exact-id escape hatch for sets not yet cached. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', position: 'relative' }}>
              <p style={{ fontSize: '0.7rem', color: !scanSetCode ? 'var(--accent-yellow)' : setPrep === 'ready' ? 'var(--type-grass)' : 'var(--text-secondary)', margin: 0, textAlign: 'center', fontWeight: 600 }}>
                {!scanSetCode
                  ? 'Tip: search your box’s set for accurate one-step scans of that set.'
                  : setPrep === 'building'
                    ? `Preparing set ${scanSetCode}… (one-time, ~1 min). Scans work meanwhile.`
                    : setPrep === 'ready'
                      ? `Set ${scanSetCode} ready: exact matches, no set to pick.`
                      : `Set ${scanSetCode}.`}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Set</label>
                <input
                  type="text"
                  value={scanSetCode}
                  onChange={(e) => { setScanSetCode(e.target.value); setSetSearchOpen(true); }}
                  onFocus={() => setSetSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSetSearchOpen(false), 150)}
                  placeholder={scanGame === 'mtg' ? 'Search set name or code (e.g. Foundations, FDN)' : 'Search set name or id (e.g. Surging Sparks, sv8)'}
                  style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', border: `1px solid ${scanSetCode ? 'var(--type-grass)' : 'var(--border-glass)'}`, borderRadius: 'var(--radius-sm)', color: '#fff' }}
                />
                {scanSetCode && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '0.2rem 0.4rem' }} onClick={() => { setScanSetCode(''); setSetSearchOpen(false); }}>Clear</button>
                )}
              </div>
              {setSearchOpen && setSuggestions.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: '0.2rem', background: 'var(--bg-elevated, #1c1c22)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', maxHeight: '220px', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                  {setSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={() => { setScanSetCode(setScanCode(s)); setSetSearchOpen(false); }}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', width: '100%', padding: '0.4rem 0.6rem', background: 'none', border: 'none', color: '#fff', fontSize: '0.75rem', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0 }}>{setScanCode(s)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Auto-Capture: scan every few seconds without tapping Capture. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Auto-Capture</span>
              <button
                type="button"
                className={`btn ${autoScan ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setAutoScan(!autoScan)}
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
              >
                {autoScan ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          {/* Scan crop + candidate diagnostics — only render when we actually have
              a crop/candidates, so an empty dashed box doesn't eat vertical space on phone. */}
          {cameraActive && (debugHashImg || debugCandidates.length > 0) && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              {/* Hash-match diagnostics: what was cropped + the ranked candidates. */}
              {(debugHashImg || debugCandidates.length > 0) && (
                <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                  {debugHashImg && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Hashed Crop</span>
                      <img src={debugHashImg} style={{ width: '52px', maxHeight: '80px', objectFit: 'contain', background: '#111', borderRadius: '3px', border: '1px solid var(--border-glass-hover)' }} alt="Hashed crop" />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    {debugScoped !== null && (
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: debugScoped ? 'var(--type-grass)' : 'var(--accent-red)' }}>
                        {debugScoped ? `✓ Set-scoped: ${debugScoped}` : '✗ GLOBAL search (not scoped to a set)'}
                      </span>
                    )}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Top matches ({debugCandidates[0]?.verified ? 'ORB inliers' : 'similarity'}, higher = closer)</span>
                    {debugCandidates.length === 0 ? (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>No candidates.</span>
                    ) : debugCandidates.map((cd, i) => {
                      const pass = cd.verified ? cd.inliers >= SCAN_MATCH_MIN_INLIERS : cd.score >= SCAN_MATCH_MIN_SCORE;
                      const label = cd.verified ? `${cd.inliers} inl` : (cd.score != null ? cd.score.toFixed(2) : '?');
                      return (
                        <div key={i} style={{ fontSize: '0.7rem', color: i === 0 ? '#fff' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ color: pass ? 'var(--type-grass)' : 'var(--accent-red)', fontWeight: 700 }}>{label}</span>
                          {' '}{cd.name} <span style={{ color: 'var(--text-muted)' }}>({cd.set} #{cd.number})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn btn-secondary" onClick={stopCamera} style={{ flex: 1 }}>
              Stop Camera
            </button>
            {loading ? (
              <button className="btn btn-primary" onClick={handleCancelScan} style={{ flex: 2, backgroundColor: 'var(--accent-red)', borderColor: 'var(--accent-red)' }}>
                Cancel Scan
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleCapture} style={{ flex: 2 }}>
                Capture & Identify
              </button>
            )}
          </div>
        </div>
      )}

      {/* Scan Status Log */}
      {scanStatus && (
        <div className="glass-panel" style={{ width: '100%', padding: '1rem', borderLeft: '3px solid var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {loading && <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>}
          <span style={{ fontSize: '0.85rem', color: '#fff', fontWeight: 500 }}>{scanStatus}</span>
        </div>
      )}

      {/* Auto Add Countdown Overlay */}
      {autoAddTargetCard && autoAddCountdown !== null && (
        <div 
          className="modal-backdrop" 
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem'
          }}
        >
          <div className="glass-panel animate-fade-in" style={{ maxWidth: '420px', width: '100%', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-red)' }}>
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>Exact Match Identified!</span>
              <h3 style={{ fontSize: '1.25rem', color: '#fff', margin: '0.25rem 0 0.5rem 0' }}>{autoAddTargetCard.name}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{autoAddTargetCard.set_name} • #{autoAddTargetCard.number}</p>
            </div>

            <div style={{ position: 'relative', width: '115px', aspectRatio: 0.718, margin: '0.5rem 0' }}>
              <img src={autoAddTargetCard.image_url} alt={autoAddTargetCard.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />
              <div style={{
                position: 'absolute',
                top: '-10px',
                right: '-10px',
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: 'var(--accent-red)',
                border: '2px solid #fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 900,
                fontSize: '1rem',
                boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
              }}>
                {autoAddCountdown}
              </div>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Auto-adding to collection in {autoAddCountdown}s...</span>
              <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
                <button 
                  type="button"
                  className="btn btn-primary" 
                  onClick={() => {
                    const card = autoAddTargetCard;
                    setAutoAddTargetCard(null);
                    setAutoAddCountdown(null);
                    autoAddCard(card);
                  }}
                  style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
                >
                  Add Now
                </button>
                <button 
                  type="button"
                  className="btn btn-secondary" 
                  onClick={() => {
                    setAutoAddTargetCard(null);
                    setAutoAddCountdown(null);
                    showToast('Auto-add cancelled.');
                  }}
                  style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scan Results Suggestions Popup Modal */}
      {scanMatches.length > 0 && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ maxWidth: '560px', width: '100%', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <h3 style={{ fontSize: '1.1rem', color: '#fff', margin: 0 }}>Identified Cards Found</h3>
              <button 
                className="btn btn-secondary btn-icon-only" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  startCamera();
                }} 
                style={{ borderRadius: '50%' }}
                title="Close and Rescan"
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                Select the correct card to add to your collection.
              </p>
              
              {/* Manual search fallback within the modal */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input 
                  type="text" 
                  placeholder="Manual search (e.g. FDN 540 or Pikachu)" 
                  className="input-control"
                  style={{ flex: 1, padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      const q = e.target.value.trim();
                      const p = new URLSearchParams({ game: scanGame });
                      
                      if (scanGame === 'mtg') {
                        // Very simple fallback: try to parse set code and number if format looks like "SET 123"
                        const match = q.match(/^([A-Z0-9]{3,5})\s+(\d+[A-Z★]?)$/i);
                        if (match) {
                          p.append('set', match[1]);
                          p.append('number', match[2]);
                        } else {
                          p.append('name', q);
                        }
                      } else {
                         // Pokemon: just try name or number
                         if (/^\d+$/.test(q)) p.append('number', q);
                         else p.append('name', q);
                      }
                      
                      const searchResponse = await fetch(`/api/search?${p.toString()}`);
                      if (searchResponse.ok) {
                        const m = await searchResponse.json();
                        if (m.length) {
                          setScanMatches(m);
                        } else {
                          showToast('No cards found for manual search.');
                        }
                      }
                    }
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '1rem', maxHeight: '350px', overflowY: 'auto', padding: '0.25rem' }}>
              {scanMatches.map(card => (
                <div key={card.id} className="tcg-card" onClick={() => openQuickAdd(card)} style={{ cursor: 'pointer' }}>
                  <div className="tcg-card-inner" style={{ border: '1px solid var(--border-glass-hover)' }}>
                    <img src={card.image_url} alt={card.name} className="tcg-card-image" />
                  </div>
                  <div className="tcg-card-info" style={{ textAlign: 'center', marginTop: '0.5rem' }}>
                    <div className="tcg-card-name" style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff' }}>{card.name}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-yellow)', marginTop: '0.2rem' }}>${formatPrice(card.price_trend)}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
              <button 
                className="btn btn-primary" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  startCamera();
                }} 
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
              >
                <RefreshCw size={14} />
                <span>Rescan / Try Again</span>
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  startCamera();
                }} 
                style={{ flex: 1 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Scans History Panel */}
      {recentScans.length > 0 && (
        <div className="glass-panel" style={{ width: '100%', marginTop: '1rem' }}>
          <h3 style={{ fontSize: '1rem', color: '#fff', marginBottom: '0.85rem', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Recent Scans</span>
            <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => setRecentScans([])}>Clear History</button>
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {recentScans.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <img src={item.image_url} alt={item.name} style={{ width: '36px', height: '50px', objectFit: 'cover', borderRadius: '2px', boxShadow: '0 2px 5px rgba(0,0,0,0.3)' }} />
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff' }}>{item.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{item.set_name} • #{item.number} • {item.rarity}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-yellow)' }}>${formatPrice(item.price_trend)}</div>
                  {item.placementLabel ? (
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#ffc107', background: 'rgba(255, 193, 7, 0.1)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{item.placementLabel}</span>
                  ) : (
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--type-grass)', background: 'rgba(74, 222, 128, 0.1)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>Unsorted</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button 
            type="button" 
            className="btn btn-primary" 
            style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', width: '100%', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} 
            onClick={() => {
              if (setActiveTab) setActiveTab('storage');
            }}
          >
            <Library size={16} />
            Start Sorting Coordinator ({recentScans.length} card(s))
          </button>
        </div>
      )}

      {/* Drawer Overlay for Selected Card */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ color: '#fff', fontSize: '1.25rem', margin: 0 }}>Add Scanned Card</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>{getCardDisplayName(selectedCard.name, language)} ({selectedCard.set_name} • #{selectedCard.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            {/* Three Column Layout (No vertical scroll) */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="quick-add-grid" style={{ gridTemplateColumns: '200px 1fr' }}>
                
                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img 
                    src={selectedCard.image_url} 
                    alt={selectedCard.name} 
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market ({printing})</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      ${formatPrice(resolveCardPrice(selectedCard, printing))}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Rarity: <span style={{ color: '#fff', fontWeight: 600 }}>{selectedCard.rarity || 'Common'}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Card Properties Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">Card Properties</div>
                  
                  <div className="quick-add-fields-group">
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Quantity</label>
                      <input 
                        type="number" 
                        className="input-control" 
                        min="1" 
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Purchase Price ($)</label>
                      <input 
                        type="number" 
                        step="0.01" 
                        className="input-control" 
                        value={purchasePrice}
                        onChange={(e) => setPurchasePrice(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Condition</label>
                      <select className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
                        {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Printing</label>
                      <select className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
                        {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>

                    <div className="form-group quick-add-full-width" style={{ marginBottom: 0 }}>
                      <label>Language</label>
                      <select className="select-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                        {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>


                  </div>
                </div>
              </div>

              {/* Submit Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} style={{ padding: '0.5rem 1.5rem' }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 2rem' }}>Add to Collection</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default CameraScanner;

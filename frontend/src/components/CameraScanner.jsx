import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, Plus, X, Search, Settings, Library, MapPin } from 'lucide-react';
import Tesseract from 'tesseract.js';
import confetti from 'canvas-confetti';
import { getCardDisplayName } from '../utils/langHelper';
import { translateJapaneseName } from '../utils/pokemonTranslation';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';

// Turn a failed /api/search response into a user-facing message. 429 (rate
// limit) and 403 (bad API key) are called out distinctly so the user knows to
// back off vs. fix their key, instead of seeing a generic "server error".
function searchFailureMessage(status) {
  if (status === 429) return 'Rate limit reached. Auto-scan paused — wait a moment before scanning again.';
  if (status === 403) return 'Pokémon TCG API key was rejected. Check it in Settings.';
  return 'Search failed. Server error.';
}

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
  const [bulkMode, setBulkMode] = useState(false);
  const [guideScale, setGuideScale] = useState(0.70); // Adjustable guide box scale
  const [guideRotation, setGuideRotation] = useState(0);
  const [guideOffsetX, setGuideOffsetX] = useState(0);
  const [guideOffsetY, setGuideOffsetY] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [videoRatio, setVideoRatio] = useState(null);
  const [cardLayout, setCardLayout] = useState('modern');
  
  // Scanned card text review overrides
  const [scannedName, setScannedName] = useState('');
  const [scannedNumber, setScannedNumber] = useState('');
  
  // OCR Binarization debug images
  const [debugNameImg, setDebugNameImg] = useState('');
  const [debugNumLeftImg, setDebugNumLeftImg] = useState('');
  const [debugNumRightImg, setDebugNumRightImg] = useState('');
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
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

  // Touch/Mouse gesture state for overlay manipulation
  const isDragging = useRef(false);
  const startPan = useRef({ x: 0, y: 0 });
  const startOffset = useRef({ x: 0, y: 0 });
  const initialPinchDist = useRef(null);
  const initialPinchAngle = useRef(null);
  const initialScale = useRef(null);
  const initialRotation = useRef(null);
  const activePointers = useRef(new Map());

  // Gesture Handlers
  const handlePointerDown = (e) => {
    e.target.setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, e);
    
    if (activePointers.current.size === 1) {
      isDragging.current = true;
      startPan.current = { x: e.clientX, y: e.clientY };
      startOffset.current = { x: guideOffsetX, y: guideOffsetY };
    } else if (activePointers.current.size === 2) {
      isDragging.current = false;
      const pointers = Array.from(activePointers.current.values());
      const dx = pointers[1].clientX - pointers[0].clientX;
      const dy = pointers[1].clientY - pointers[0].clientY;
      initialPinchDist.current = Math.hypot(dx, dy);
      initialPinchAngle.current = Math.atan2(dy, dx) * (180 / Math.PI);
      initialScale.current = guideScale;
      initialRotation.current = guideRotation;
    }
  };

  const handlePointerMove = (e) => {
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, e);

    if (activePointers.current.size === 1 && isDragging.current) {
      const dx = e.clientX - startPan.current.x;
      const dy = e.clientY - startPan.current.y;
      
      let newX = startOffset.current.x + dx;
      let newY = startOffset.current.y + dy;
      
      const guide = document.querySelector('.scan-card-guide');
      const video = videoRef.current;
      if (guide && video) {
        const W = video.clientWidth;
        const H = video.clientHeight;
        const w = guide.offsetWidth;
        const h = guide.offsetHeight;
        
        const rad = guideRotation * (Math.PI / 180);
        const boundingW = w * Math.abs(Math.cos(rad)) + h * Math.abs(Math.sin(rad));
        const boundingH = w * Math.abs(Math.sin(rad)) + h * Math.abs(Math.cos(rad));
        
        const maxX = Math.max(0, (W - boundingW) / 2);
        const maxY = Math.max(0, (H - boundingH) / 2);
        
        newX = Math.max(-maxX, Math.min(maxX, newX));
        newY = Math.max(-maxY, Math.min(maxY, newY));
      }
      
      setGuideOffsetX(newX);
      setGuideOffsetY(newY);
    } else if (activePointers.current.size === 2) {
      const pointers = Array.from(activePointers.current.values());
      const dx = pointers[1].clientX - pointers[0].clientX;
      const dy = pointers[1].clientY - pointers[0].clientY;
      
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      
      if (initialPinchDist.current) {
        const scaleFactor = dist / initialPinchDist.current;
        let newScale = initialScale.current * scaleFactor;
        newScale = Math.max(0.4, Math.min(newScale, 1.0));
        setGuideScale(newScale);
      }
      
      if (initialPinchAngle.current !== null) {
        const angleDelta = angle - initialPinchAngle.current;
        let newRotation = initialRotation.current + angleDelta;
        newRotation = ((newRotation % 360) + 360) % 360;
        setGuideRotation(Math.round(newRotation));
      }
    }
  };

  const handlePointerUp = (e) => {
    e.target.releasePointerCapture(e.pointerId);
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) {
      initialPinchDist.current = null;
      initialPinchAngle.current = null;
    }
    if (activePointers.current.size === 0) {
      isDragging.current = false;
    }
  };

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [locations, setLocations] = useState([]);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  // Target container for scanned cards — persisted so a bulk scanning session
  // keeps filing into the same box/binder across visits.
  const [locationId, setLocationIdState] = useState(() => localStorage.getItem('scanner_target_location') || '');
  const setLocationId = (value) => {
    setLocationIdState(value);
    localStorage.setItem('scanner_target_location', value);
  };

  // Keep a ref mirroring the latest stream so the unmount cleanup below (whose
  // closure is fixed from the first render) can always stop the live tracks.
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Clean up camera stream on unmount
  useEffect(() => {
    fetchLocations();
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
        // Drop a persisted target that no longer exists (container was deleted).
        const stored = localStorage.getItem('scanner_target_location');
        if (stored && !data.some(l => String(l.id) === stored)) {
          setLocationId('');
        }
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    }
  };

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
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard]);

  const startCamera = async () => {
    setHasCameraError(false);
    setScanMatches([]);
    setScanStatus('');
    setScannedName('');
    setScannedNumber('');
    setDebugNameImg('');
    setDebugNumLeftImg('');
    setDebugNumRightImg('');
    setShowSettings(false);
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
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setCameraActive(false);
    setAutoScan(false); // Reset autoScan on camera stop
    setScannedName('');
    setScannedNumber('');
    setDebugNameImg('');
    setDebugNumLeftImg('');
    setDebugNumRightImg('');
    setShowSettings(false);
    setVideoRatio(null);
  };

  const handleManualSearch = async (e) => {
    if (e) e.preventDefault();
    if (!scannedName && !scannedNumber) return;
    
    setLoading(true);
    setScanMatches([]);
    setScanStatus(`Searching database for: ${scannedName} ${scannedNumber}...`);
    
    try {
      const params = new URLSearchParams();
      if (scannedName) params.append('name', scannedName);
      if (scannedNumber) params.append('number', scannedNumber);
      
      const response = await fetch(`/api/search?${params.toString()}`);
      if (response.ok) {
        const matches = await response.json();
        setScanMatches(matches);
        if (matches.length === 0) {
          setScanStatus(`Could not find cards matching "${scannedName}" (${scannedNumber}). Try again.`);
        } else {
          setScanStatus(`Found ${matches.length} matching card(s)!`);
          if (matches.length === 1) {
            if (autoScan) {
              setAutoAddTargetCard(matches[0]);
              setAutoAddCountdown(2);
              setScanMatches([]);
            } else if (bulkMode) {
              await autoAddCard(matches[0]);
              setScanMatches([]);
            } else {
              stopCamera();
              openQuickAdd(matches[0]);
            }
          }
        }
      } else {
        if (response.status === 429) setAutoScan(false); // stop the loop from hammering the API
        setScanStatus(searchFailureMessage(response.status));
      }
    } catch (err) {
      console.error(err);
      setScanStatus('Search failed.');
    } finally {
      setLoading(false);
    }
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
          location_id: locationId ? parseInt(locationId, 10) : null
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
  const getOrientedVideoCanvas = (video) => {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const canvas = document.createElement('canvas');
    
    const videoRect = video.getBoundingClientRect();
    const streamRatio = videoWidth / videoHeight;
    const visualRatio = videoRect.width / videoRect.height;
    
    // Detect if browser displays stream rotated relative to raw texture resolution
    // (If stream is landscape but display container is portrait, or vice versa)
    const isRotated = (streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0);
    
    if (isRotated) {
      canvas.width = videoHeight; // e.g. 720
      canvas.height = videoWidth; // e.g. 1280
      const ctx = canvas.getContext('2d');
      
      // Rotate 90 degrees clockwise around center
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
    } else {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    }
    
    return canvas;
  };

  // Preprocess cropped canvas for higher OCR accuracy (Binarization / Thresholding)
  // Bypasses browser-incompatible canvas context filters to run natively on mobile devices.
  const getProcessedDataUrl = (sourceCanvas, cx, cy, w, h, rotationDeg) => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w * 4; // Upscale by 4x for high-res OCR on small text
    tempCanvas.height = h * 4;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Enable high-quality image smoothing for clean bicubic interpolation
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';
    
    // Extract rotated crop by inverse rotating the canvas context
    tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    tempCtx.rotate(-rotationDeg * (Math.PI / 180));
    tempCtx.scale(4, 4); // Apply the 4x upscale
    tempCtx.drawImage(sourceCanvas, -cx, -cy);
    
    // Reset transform before pixel manipulation (not strictly necessary but safe)
    tempCtx.setTransform(1, 0, 0, 1, 0, 0);
    
    // Apply pixel-level high-contrast grayscale enhancement
    // (Grayscale with linear contrast stretching is superior to harsh binarization for anti-aliased fonts)
    try {
      const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      const data = imageData.data;
      const len = data.length;
      
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        
        // Calculate standard luminance
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // Boost contrast (stretch scale centered around 128)
        const contrastFactor = 2.0; 
        let value = contrastFactor * (luma - 128) + 128;
        value = Math.max(0, Math.min(255, value)); // Clamp
        
        data[i] = value;
        data[i+1] = value;
        data[i+2] = value;
      }
      
      tempCtx.putImageData(imageData, 0, 0);
    } catch (e) {
      console.error('Manual pixel thresholding failed, using raw crop:', e);
    }
    
    return tempCanvas.toDataURL('image/jpeg', 0.95);
  };

  const handleCapture = async () => {
    if (loading || !videoRef.current || !cameraActive) return;

    setLoading(true);
    const scanId = ++currentScanId.current;
    setScanMatches([]);
    setScanStatus('Initializing OCR scanner...');

    const video = videoRef.current;
    const videoRect = video.getBoundingClientRect();
    
    const guideElement = document.querySelector('.scan-card-guide');
    if (!guideElement) {
      setLoading(false);
      setScanStatus('Error: Guide box overlay not found.');
      return;
    }
    const guideRect = guideElement.getBoundingClientRect();

    // 1. Capture and correctly orient the video frame onto a canvas
    const orientedCanvas = getOrientedVideoCanvas(video);
    
    // Scaling factors to translate actual screen bounds to oriented canvas bounds
    const scaleX = orientedCanvas.width / videoRect.width;
    const scaleY = orientedCanvas.height / videoRect.height;

    // Extract crops directly from the visual overlay guides on screen, 
    // ensuring perfect alignment even if the parent overlay is translated or rotated.
    const titleGuide = document.querySelector('.scan-region-title');
    const leftNumGuide = document.querySelector('.scan-region-number-left');
    const rightNumGuide = document.querySelector('.scan-region-number-right');

    const getCropParams = (guideNode) => {
      if (!guideNode) return null;
      const rect = guideNode.getBoundingClientRect();
      const screenCX = rect.left + rect.width / 2;
      const screenCY = rect.top + rect.height / 2;
      return {
        cx: (screenCX - videoRect.left) * scaleX,
        cy: (screenCY - videoRect.top) * scaleY,
        w: guideNode.offsetWidth * scaleX,
        h: guideNode.offsetHeight * scaleY
      };
    };

    const nameCrop = getCropParams(titleGuide);
    const numLeftCrop = getCropParams(leftNumGuide);
    const numRightCrop = getCropParams(rightNumGuide);

    try {
      // 2. Process crop images using the oriented canvas
      // We pass the center points, dimensions, and current rotation to inverse-rotate the crop perfectly!
      const nameDataUrl = nameCrop ? getProcessedDataUrl(orientedCanvas, nameCrop.cx, nameCrop.cy, nameCrop.w, nameCrop.h, guideRotation) : '';
      setDebugNameImg(nameDataUrl);

      let numLeftDataUrl = '';
      if (numLeftCrop) {
        numLeftDataUrl = getProcessedDataUrl(orientedCanvas, numLeftCrop.cx, numLeftCrop.cy, numLeftCrop.w, numLeftCrop.h, guideRotation);
        setDebugNumLeftImg(numLeftDataUrl);
      } else {
        setDebugNumLeftImg('');
      }

      let numRightDataUrl = '';
      if (numRightCrop) {
        numRightDataUrl = getProcessedDataUrl(orientedCanvas, numRightCrop.cx, numRightCrop.cy, numRightCrop.w, numRightCrop.h, guideRotation);
        setDebugNumRightImg(numRightDataUrl);
      } else {
        setDebugNumRightImg('');
      }

      // 3. Perform OCR on Card Name (PSM 7: Treat image as a single text line)
      setScanStatus('Reading Card Name...');
      const nameOcrLang = cardLayout === 'japanese' ? 'jpn' : 'eng';
      const nameResult = await Tesseract.recognize(nameDataUrl, nameOcrLang, {
        parameters: {
          tessedit_pageseg_mode: '7'
        }
      });
      if (scanId !== currentScanId.current) return;
      const nameRaw = nameResult.data.text.trim();
      
      let detectedName = '';
      if (cardLayout === 'japanese') {
        const cleanedJpName = nameRaw.replace(/\s+/g, '').replace(/[^\p{L}\d]/gu, '').trim();
        detectedName = translateJapaneseName(cleanedJpName) || cleanedJpName;
        console.log(`Japanese OCR Read: "${nameRaw}" -> Cleaned: "${cleanedJpName}" -> English: "${detectedName}"`);
      } else {
        // Clean name (strip extra characters and common template tags like 'HP' or 'Stage')
        const cleanNameParts = nameRaw.replace(/[^a-zA-Z0-9\s\-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
        const stopwords = ['HP', 'STAGE', 'BASIC', 'EVOLVES', 'FROM', 'LV', 'LEVEL', 'NO', 'PROMO', 'TRAINER', 'ENERGY', 'ITEM', 'STADIUM', 'SUPPORTER', 'POKEMON', 'POKÉMON', 'STAGE1', 'STAGE2', 'MEGA', 'VMAX', 'VSTAR'];
        const filteredNameParts = cleanNameParts.filter(w => {
          const upper = w.toUpperCase();
          if (stopwords.includes(upper)) return false;
          if (/^\d+$/.test(w)) return false; // skip pure numbers like HP values (e.g. 120)
          if (w.length === 1 && upper !== 'V') return false;
          return true;
        });
        detectedName = filteredNameParts.slice(0, 3).join(' ').trim();
      }

      // 4. Perform OCR on Card Numbers in parallel depending on layout (forcing PSM 7 text line)
      setScanStatus('Reading Card Number...');
      const ocrPromises = [];
      if (numLeftDataUrl) {
        ocrPromises.push(
          Tesseract.recognize(numLeftDataUrl, 'eng', {
            parameters: {
              tessedit_pageseg_mode: '7'
            }
          }).then(res => ({ side: 'left', text: res.data.text.trim() }))
        );
      }
      if (numRightDataUrl) {
        ocrPromises.push(
          Tesseract.recognize(numRightDataUrl, 'eng', {
            parameters: {
              tessedit_pageseg_mode: '7'
            }
          }).then(res => ({ side: 'right', text: res.data.text.trim() }))
        );
      }

      const ocrResults = await Promise.all(ocrPromises);
      if (scanId !== currentScanId.current) return;
      let numLeftRaw = '';
      let numRightRaw = '';
      for (const res of ocrResults) {
        if (res.side === 'left') numLeftRaw = res.text;
        if (res.side === 'right') numRightRaw = res.text;
      }
      
      // Helper to extract numerator (card number) and map common character recognition failures
      const extractNumber = (raw) => {
        // Map common OCR letter confusions to numbers
        const mapped = raw
          .replace(/[Oo]/g, '0')
          .replace(/[Ii|l]/g, '1')
          .replace(/[Zz]/g, '2')
          .replace(/[Ss]/g, '5')
          .replace(/[Bb]/g, '8');

        const slashMatch = mapped.match(/([0-9]+)\s*\/\s*([0-9]+)/);
        if (slashMatch) return slashMatch[1].trim();
        
        const standAloneMatch = mapped.match(/([0-9]+)/);
        if (standAloneMatch) return standAloneMatch[0].trim();
        
        return '';
      };

      let detectedNumberLeft = extractNumber(numLeftRaw);
      let detectedNumberRight = extractNumber(numRightRaw);

      // Discard long garbage blocks
      if (detectedNumberLeft.length > 8) detectedNumberLeft = '';
      if (detectedNumberRight.length > 8) detectedNumberRight = '';

      // Determine best match: Prioritize the box containing actual digits, falling back to either non-empty read
      let detectedNumber = '';
      if (/\d+/.test(detectedNumberRight)) {
        detectedNumber = detectedNumberRight;
      } else if (/\d+/.test(detectedNumberLeft)) {
        detectedNumber = detectedNumberLeft;
      } else {
        detectedNumber = detectedNumberRight || detectedNumberLeft;
      }

      console.log(`OCR Raw Name Text: "${nameRaw}"`);
      console.log(`OCR Cleaned Name: "${detectedName}"`);
      console.log(`OCR Left Number Read: "${detectedNumberLeft}" (raw: "${numLeftRaw}")`);
      console.log(`OCR Right Number Read: "${detectedNumberRight}" (raw: "${numRightRaw}")`);
      console.log(`OCR Selected Number: "${detectedNumber}"`);

      // Update input preview values for manual correction overrides
      setScannedName(detectedName);
      setScannedNumber(detectedNumber);

      if (!detectedName && !detectedNumber) {
        setScanStatus('OCR failed. Could not read card. Please align card clearly in the guide boxes.');
        setScanFlash('error');
        setTimeout(() => setScanFlash(null), 1500);
        setLoading(false);
        return;
      }

      // 4. Query local database & API
      setScanStatus(`Searching database for: ${detectedName} ${detectedNumber}...`);
      const params = new URLSearchParams();
      if (detectedName) params.append('name', detectedName);
      if (detectedNumber) params.append('number', detectedNumber);

      const searchResponse = await fetch(`/api/search?${params.toString()}`);
      if (scanId !== currentScanId.current) return;
      if (searchResponse.ok) {
        const matches = await searchResponse.json();
        setScanMatches(matches);
        
        if (matches.length === 0) {
          setScanStatus(`Could not find cards matching "${detectedName}" (${detectedNumber}). Try again or search manually.`);
          setScanFlash('error');
          setTimeout(() => setScanFlash(null), 1500);
        } else {
          setScanStatus(`Found ${matches.length} matching card(s)!`);
          setScanFlash('success');
          setTimeout(() => setScanFlash(null), 1500);
          
          // Auto-open drawer if exactly one perfect match is found, or auto-add in bulk mode
          if (matches.length === 1) {
            if (autoScan) {
              setAutoAddTargetCard(matches[0]);
              setAutoAddCountdown(2);
              setScanMatches([]);
            } else if (bulkMode) {
              await autoAddCard(matches[0]);
              setScanMatches([]); // Clear results so auto-scan loop triggers again
            } else {
              stopCamera();
              openQuickAdd(matches[0]);
            }
          }
        }
      } else {
        if (searchResponse.status === 429) setAutoScan(false); // stop the loop from hammering the API
        setScanStatus(searchFailureMessage(searchResponse.status));
        setScanFlash('error');
        setTimeout(() => setScanFlash(null), 1500);
      }
    } catch (err) {
      console.error('OCR Process failed:', err);
      if (scanId === currentScanId.current) setScanStatus('OCR processing failed. Please search manually.');
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
    if (cardLayout === 'japanese') {
      setLanguage('Japanese');
    } else {
      setLanguage('English');
    }
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
          location_id: locationId ? parseInt(locationId, 10) : null
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

      {/* Target container: where scanned cards get filed. The backend picks the
          exact page/row slot and the add toast tells the user where to put the
          physical card. */}
      <div className="glass-panel" style={{ width: '100%', padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
        <MapPin size={15} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Store scans in</span>
        <select
          className="select-control"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          style={{ flex: 1, fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}
        >
          <option value="">Unsorted (file later)</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
        </select>
      </div>

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
            className="camera-preview-wrapper"
            style={{
              ...(videoRatio ? { aspectRatio: `${videoRatio}` } : {}),
              touchAction: 'none'
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
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
              <div 
                className="scan-card-guide" 
                style={{ 
                  aspectRatio: '2.5 / 3.5',
                  width: (videoRatio && videoRatio > 1) ? 'auto' : `${guideScale * 100}%`,
                  height: (videoRatio && videoRatio > 1) ? `${guideScale * 100}%` : 'auto',
                  transform: `translate(${guideOffsetX}px, ${guideOffsetY}px) rotate(${guideRotation}deg)`,
                  animation: scanFlash === 'success' ? 'border-flash-success 1.5s ease-in-out' : scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {/* Name Guide: shift lower and widen if trainer layout */}
                <div 
                  className="scan-region-title" 
                  style={
                    cardLayout === 'trainer' ? { top: '11%', height: '7%', width: '75%' } :
                    cardLayout === 'vintage' ? { top: '8%', height: '6.5%' } :
                    {}
                  }
                />
                
                {/* Left Number Guide: show for Modern, Trainer, Japanese (custom left positioning for Japanese) */}
                {(cardLayout === 'modern' || cardLayout === 'trainer' || cardLayout === 'japanese') && (
                  <div 
                    className="scan-region-number-left" 
                    style={cardLayout === 'japanese' ? { left: '4%', bottom: '5%' } : {}}
                  />
                )}
                
                {/* Right Number Guide: show for Vintage, Trainer, Japanese */}
                {(cardLayout === 'vintage' || cardLayout === 'trainer' || cardLayout === 'japanese') && (
                  <div 
                    className="scan-region-number-right" 
                    style={
                      cardLayout === 'japanese' ? { right: '4%', bottom: '5%' } : 
                      cardLayout === 'vintage' ? { right: '4%', width: '30%' } :
                      {}
                    }
                  />
                )}
                
                {loading && <div className="scan-line"></div>}
              </div>
            </div>
          </div>

          {/* Collapsible Settings Accordion (CardSlinger Configurations) */}
          <button 
            type="button" 
            className="btn btn-secondary" 
            style={{ width: '100%', padding: '0.45rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)' }}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings size={14} /> {showSettings ? 'Hide Scanner Settings' : 'Configure Scanner Settings'}
          </button>

          {showSettings && (
            <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '-0.25rem', marginBottom: '0.25rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.25rem' }}>
                Scanner Configurations
              </div>
              
              {/* Toggles Row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
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

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Bulk Auto-Add</span>
                  <button 
                    type="button"
                    className={`btn ${bulkMode ? 'btn-primary' : 'btn-secondary'}`} 
                    onClick={() => {
                      setBulkMode(!bulkMode);
                      if (!bulkMode) {
                        setAutoScan(true);
                        showToast('Bulk Mode enabled: Identified cards add automatically!');
                      }
                    }}
                    style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
                  >
                    {bulkMode ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>

              {/* Overlay Fine-Tuning */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(0,0,0,0.15)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Overlay Scale</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-primary)' }}>{Math.round(guideScale * 100)}%</span>
                </div>
                <input type="range" min="40" max="100" step="5" value={guideScale * 100} onChange={(e) => setGuideScale(parseFloat(e.target.value) / 100)} style={{ width: '100%', cursor: 'pointer' }} />
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Rotation Offset</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-primary)' }}>{guideRotation}°</span>
                </div>
                <input type="range" min="0" max="360" step="1" value={guideRotation} onChange={(e) => setGuideRotation(parseInt(e.target.value, 10))} style={{ width: '100%', cursor: 'pointer' }} />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Location Offset (X / Y)</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-primary)' }}>{Math.round(guideOffsetX)}px, {Math.round(guideOffsetY)}px</span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input type="range" min="-300" max="300" step="1" value={guideOffsetX} onChange={(e) => setGuideOffsetX(parseInt(e.target.value, 10))} style={{ flex: 1, cursor: 'pointer' }} title="Horizontal Shift" />
                  <input type="range" min="-300" max="300" step="1" value={guideOffsetY} onChange={(e) => setGuideOffsetY(parseInt(e.target.value, 10))} style={{ flex: 1, cursor: 'pointer' }} title="Vertical Shift" />
                </div>
                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.65rem', padding: '0.2rem', marginTop: '0.25rem' }} onClick={() => { setGuideScale(0.70); setGuideRotation(0); setGuideOffsetX(0); setGuideOffsetY(0); }}>Reset Overlay</button>
              </div>

              {/* Card Layout Selection */}
              <div className="sub-nav-tabs" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
                {['modern', 'vintage', 'trainer', 'japanese'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`sub-nav-tab ${cardLayout === mode ? 'active' : ''}`}
                    style={{ padding: '0.5rem', fontSize: '0.75rem', textTransform: 'capitalize' }}
                    onClick={() => setCardLayout(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* OCR Crop Results */}
          {cameraActive && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              {/* Show cropped OCR feeds for alignment debugging */}
              {(debugNameImg || debugNumLeftImg || debugNumRightImg) && (
                <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                  {debugNameImg && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Name Crop Feed</span>
                      <img src={debugNameImg} style={{ width: '100%', height: '28px', objectFit: 'contain', background: '#fff', borderRadius: '2px', border: '1px solid var(--border-glass-hover)' }} alt="Name Crop" />
                    </div>
                  )}
                  {debugNumLeftImg && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Modern No. Crop</span>
                      <img src={debugNumLeftImg} style={{ width: '100%', height: '28px', objectFit: 'contain', background: '#fff', borderRadius: '2px', border: '1px solid var(--border-glass-hover)' }} alt="Modern Number Crop" />
                    </div>
                  )}
                  {debugNumRightImg && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Vintage No. Crop</span>
                      <img src={debugNumRightImg} style={{ width: '100%', height: '28px', objectFit: 'contain', background: '#fff', borderRadius: '2px', border: '1px solid var(--border-glass-hover)' }} alt="Vintage Number Crop" />
                    </div>
                  )}
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

      {/* OCR Scan Status Log */}
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

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
              Select the correct card to add to your collection, or click <strong>Rescan</strong> to try capturing again.
            </p>

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

                    <div className="form-group quick-add-full-width" style={{ marginBottom: 0 }}>
                      <label>Store In</label>
                      <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                        <option value="">Unsorted (file later)</option>
                        {locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
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

import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, Plus, X, Search, Sparkles } from 'lucide-react';
import Tesseract from 'tesseract.js';
import confetti from 'canvas-confetti';

function CameraScanner({ onAddSuccess, showToast }) {
  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanMatches, setScanMatches] = useState([]);
  
  // Camera active states
  const [cameraActive, setCameraActive] = useState(false);
  const [hasCameraError, setHasCameraError] = useState(false);
  const [autoScan, setAutoScan] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [guideScale, setGuideScale] = useState(0.70);
  
  // Scanned card text review overrides
  const [scannedName, setScannedName] = useState('');
  const [scannedNumber, setScannedNumber] = useState('');
  
  // OCR Binarization debug images
  const [debugNameImg, setDebugNameImg] = useState('');
  const [debugNumImg, setDebugNumImg] = useState('');
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [locations, setLocations] = useState([]);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [subLocation1, setSubLocation1] = useState('');
  const [subLocation2, setSubLocation2] = useState('');

  // Clean up camera stream on unmount
  useEffect(() => {
    fetchLocations();
    return () => {
      stopCamera();
    };
  }, []);

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
        if (data.length > 0) {
          setLocationId(data[0].id);
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

  // Auto-capture scheduler: capture frame 3s after previous capture completes
  useEffect(() => {
    let timerId;
    if (cameraActive && autoScan && !isDrawerOpen && !loading && scanMatches.length === 0) {
      timerId = setTimeout(() => {
        handleCapture();
      }, 3000);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches]);

  const startCamera = async () => {
    setHasCameraError(false);
    setScanMatches([]);
    setScanStatus('');
    setScannedName('');
    setScannedNumber('');
    setDebugNameImg('');
    setDebugNumImg('');
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
    setDebugNumImg('');
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
            if (bulkMode) {
              await autoAddCard(matches[0]);
              setScanMatches([]); // Clear results so auto-scan loop continues
            } else {
              stopCamera();
              openQuickAdd(matches[0]);
            }
          }
        }
      } else {
        setScanStatus('Search failed. Server error.');
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
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: 1,
          condition: 'Near Mint',
          printing: (card.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal',
          language: 'English',
          purchase_price: card.price_trend || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
          sub_location_1: subLocation1,
          sub_location_2: subLocation2
        })
      });

      if (response.ok) {
        showToast(`Auto-Added: ${card.name} (${card.set_name})`);
        
        // Brief confetti blast for ultra-rares
        const rarity = (card.rarity || '').toLowerCase();
        if (rarity.includes('secret') || rarity.includes('ultra') || (card.price_trend || 0) > 15) {
          confetti({ particleCount: 50, spread: 40, origin: { y: 0.8 } });
        }
        
        onAddSuccess(); // Refresh stats
      } else {
        showToast(`Failed to auto-add ${card.name}`);
      }
    } catch (err) {
      console.error('Auto-add error:', err);
      showToast('Error auto-adding card.');
    }
  };

  // Preprocess cropped canvas for higher OCR accuracy (Binarization / Thresholding)
  // Bypasses browser-incompatible canvas context filters to run natively on mobile devices.
  const getProcessedDataUrl = (video, sourceX, sourceY, sourceW, sourceH) => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceW * 2; // Upscale for clearer OCR text
    tempCanvas.height = sourceH * 2;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Draw raw cropped frame first
    tempCtx.drawImage(
      video,
      sourceX, sourceY, sourceW, sourceH,
      0, 0, tempCanvas.width, tempCanvas.height
    );
    
    // Apply pixel-level adaptive thresholding
    try {
      const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      const data = imageData.data;
      const len = data.length;
      
      // Calculate average luma
      let totalLuma = 0;
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        totalLuma += luma;
      }
      const avgLuma = totalLuma / (len / 4);
      
      // Target a contrast-enhancing threshold slightly lower than average (keeps thin text lines from breaking)
      const threshold = Math.max(70, Math.min(180, avgLuma * 0.95));
      
      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // Convert to pure black (0) or pure white (255)
        const value = luma < threshold ? 0 : 255;
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
    setScanMatches([]);
    setScanStatus('Initializing OCR scanner...');

    const video = videoRef.current;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    // Mathematically exact guide coordinate mapping
    // Pokemon card physical aspect ratio is 2.5 : 3.5 (0.7143)
    const cardAspectRatio = 2.5 / 3.5;
    let guideWidth, guideHeight, guideLeft, guideTop;

    if (videoHeight > videoWidth) {
      // Portrait mode (typical phone)
      guideWidth = videoWidth * guideScale; // Matches width dynamically
      guideHeight = guideWidth / cardAspectRatio; // guideWidth * 1.4
      guideLeft = (videoWidth - guideWidth) / 2;
      guideTop = (videoHeight - guideHeight) / 2;
    } else {
      // Landscape mode (typical desktop/webcam)
      guideHeight = videoHeight * guideScale * 1.07; // scale height similarly
      guideWidth = guideHeight * cardAspectRatio; // guideHeight * 0.7143
      guideLeft = (videoWidth - guideWidth) / 2;
      guideTop = (videoHeight - guideHeight) / 2;
    }

    // Name Crop: Top ~3% to 9.5% of the card's boundary
    const nameCrop = {
      x: Math.round(guideLeft + guideWidth * 0.05),
      y: Math.round(guideTop + guideHeight * 0.03),
      w: Math.round(guideWidth * 0.90),
      h: Math.round(guideHeight * 0.065)
    };

    // Number Crop: Bottom ~93.5% to 99% of the card's boundary (full width bottom border margin)
    const numCrop = {
      x: Math.round(guideLeft + guideWidth * 0.05),
      y: Math.round(guideTop + guideHeight * 0.935),
      w: Math.round(guideWidth * 0.90),
      h: Math.round(guideHeight * 0.055)
    };

    try {
      // 1. Process images
      const nameDataUrl = getProcessedDataUrl(video, nameCrop.x, nameCrop.y, nameCrop.w, nameCrop.h);
      const numDataUrl = getProcessedDataUrl(video, numCrop.x, numCrop.y, numCrop.w, numCrop.h);

      setDebugNameImg(nameDataUrl);
      setDebugNumImg(numDataUrl);

      // 2. Perform OCR on Card Name
      setScanStatus('Reading Card Name...');
      const nameResult = await Tesseract.recognize(nameDataUrl, 'eng');
      const nameRaw = nameResult.data.text.trim();
      
      // Clean name (strip extra characters and common template tags like 'HP' or 'Stage')
      const cleanNameParts = nameRaw.replace(/[^a-zA-Z0-9\s\-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
      const stopwords = ['HP', 'STAGE', 'BASIC', 'EVOLVES', 'FROM', 'LV', 'LEVEL', 'NO', 'PROMO', 'TRAINER', 'ENERGY', 'ITEM', 'STADIUM', 'SUPPORTER'];
      const filteredNameParts = cleanNameParts.filter(w => {
        const upper = w.toUpperCase();
        if (stopwords.includes(upper)) return false;
        if (/^\d+$/.test(w)) return false; // skip pure numbers like HP values (e.g. 120)
        return true;
      });
      const detectedName = filteredNameParts.slice(0, 3).join(' ').trim(); // Take first 3 valid words (e.g. "Charizard", "Dark Raichu", "Mewtwo EX")

      // 3. Perform OCR on Card Number
      setScanStatus('Reading Card Number...');
      const numResult = await Tesseract.recognize(numDataUrl, 'eng');
      const numRaw = numResult.data.text.trim();
      
      // Match numerator (card number) from "numerator/denominator" or just a standalone alphanumeric code
      let detectedNumber = '';
      const slashMatch = numRaw.match(/([a-zA-Z0-9\-]+)\s*\/\s*([a-zA-Z0-9\-]+)/);
      if (slashMatch) {
        detectedNumber = slashMatch[1].trim(); // Extract numerator
      } else {
        const standAloneMatch = numRaw.match(/([a-zA-Z0-9\-]+)/);
        if (standAloneMatch) {
          detectedNumber = standAloneMatch[0].trim();
        }
      }

      // Safeguard: Card numbers are never exceptionally long (usually 1-5 chars, e.g. 58, 058, TG12, GG60).
      // If OCR detects garbage text block, discard it.
      if (detectedNumber.length > 8) {
        detectedNumber = '';
      }

      console.log(`OCR Raw Name Text: "${nameRaw}"`);
      console.log(`OCR Cleaned Name: "${detectedName}"`);
      console.log(`OCR Detected Number: "${detectedNumber}"`);

      // Update input preview values for manual correction overrides
      setScannedName(detectedName);
      setScannedNumber(detectedNumber);

      if (!detectedName && !detectedNumber) {
        setScanStatus('OCR failed. Could not read card. Please align card clearly in the guide boxes.');
        setLoading(false);
        return;
      }

      // 4. Query local database & API
      setScanStatus(`Searching database for: ${detectedName} ${detectedNumber}...`);
      const params = new URLSearchParams();
      if (detectedName) params.append('name', detectedName);
      if (detectedNumber) params.append('number', detectedNumber);

      const searchResponse = await fetch(`/api/search?${params.toString()}`);
      if (searchResponse.ok) {
        const matches = await searchResponse.json();
        setScanMatches(matches);
        
        if (matches.length === 0) {
          setScanStatus(`Could not find cards matching "${detectedName}" (${detectedNumber}). Try again or search manually.`);
        } else {
          setScanStatus(`Found ${matches.length} matching card(s)!`);
          
          // Auto-open drawer if exactly one perfect match is found, or auto-add in bulk mode
          if (matches.length === 1) {
            if (bulkMode) {
              await autoAddCard(matches[0]);
              setScanMatches([]); // Clear results so auto-scan loop triggers again
            } else {
              stopCamera();
              openQuickAdd(matches[0]);
            }
          }
        }
      } else {
        setScanStatus('Search failed. Server error.');
      }
    } catch (err) {
      console.error('OCR Process failed:', err);
      setScanStatus('OCR processing failed. Please search manually.');
    } finally {
      setLoading(false);
    }
  };

  const openQuickAdd = (card) => {
    setSelectedCard(card);
    setPurchasePrice(card.price_trend || 0);
    const rarity = (card.rarity || '').toLowerCase();
    if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || rarity.includes('shining')) {
      setPrinting('Holofoil');
    } else {
      setPrinting('Normal');
    }
    setSubLocation1('');
    setSubLocation2('');
    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage('English');
    setPurchasePrice(0);
    setSubLocation1('');
    setSubLocation2('');
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
          location_id: locationId ? parseInt(locationId, 10) : null,
          sub_location_1: subLocation1,
          sub_location_2: subLocation2
        })
      });

      if (response.ok) {
        showToast(`${selectedCard.name} added to collection!`);
        
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

  const selectedLocation = locations.find(l => l.id == locationId);
  const isBinder = selectedLocation ? selectedLocation.type === 'Binder' : false;
  const isBox = selectedLocation ? selectedLocation.type === 'Box' : false;

  return (
    <div className="scanner-container">
      <div className="glass-panel" style={{ width: '100%', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', color: '#fff' }}>Camera Card Scanner</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Align your card inside the guidelines, then press Capture. The client-side OCR will read the card name and collector number.
        </p>
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
          <div className="camera-preview-wrapper">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="camera-video"
            />
            {/* Outline Box Guides */}
            <div className="camera-overlay">
              <div className="scan-card-guide" style={{ width: `${guideScale * 100}%` }}>
                <div className="scan-region-title"></div>
                <div className="scan-region-number"></div>
                {loading && <div className="scan-line"></div>}
              </div>
            </div>
          </div>

          {/* Scanner Settings Control Panel (CardSlinger Configurations) */}
          <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.25rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.25rem' }}>
              Scanner Configurations (CardSlinger Mode)
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

            {/* Guide Scale Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', background: 'rgba(0,0,0,0.15)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                <span>Guide Box Sizing (Scale)</span>
                <span style={{ color: 'var(--accent-yellow)' }}>{Math.round(guideScale * 100)}%</span>
              </div>
              <input 
                type="range" 
                min="0.45" 
                max="0.95" 
                step="0.01" 
                value={guideScale}
                onChange={(e) => setGuideScale(parseFloat(e.target.value))}
                style={{ width: '100%', height: '4px', background: 'var(--bg-primary)', borderRadius: '2px', cursor: 'pointer', accentColor: 'var(--accent-red)' }}
              />
            </div>

            {/* Destination Container Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', background: 'rgba(0,0,0,0.15)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Destination Container</div>
              <select 
                className="select-control" 
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', width: '100%', marginTop: '0.15rem' }} 
                value={locationId} 
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">Unassigned Pile</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                ))}
              </select>
            </div>
          </div>

          {/* Manual OCR Correction panel */}
          <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Scanned Card Text Review
            </div>
            <form onSubmit={handleManualSearch} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
              <div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Name</span>
                <input 
                  type="text" 
                  className="input-control" 
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }} 
                  value={scannedName}
                  onChange={(e) => setScannedName(e.target.value)}
                  placeholder="Scanned name..."
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Number</span>
                <input 
                  type="text" 
                  className="input-control" 
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }} 
                  value={scannedNumber}
                  onChange={(e) => setScannedNumber(e.target.value)}
                  placeholder="Scanned number..."
                />
              </div>
              <button 
                type="submit" 
                className="btn btn-secondary" 
                style={{ padding: '0.35rem 1rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}
                disabled={loading}
              >
                Search
              </button>
            </form>

            {/* Show cropped OCR feeds for alignment debugging */}
            {(debugNameImg || debugNumImg) && (
              <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                {debugNameImg && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Name Crop Feed (Binarized)</span>
                    <img src={debugNameImg} style={{ width: '100%', height: '28px', objectFit: 'contain', background: '#fff', borderRadius: '2px', border: '1px solid var(--border-glass-hover)' }} alt="Name Crop" />
                  </div>
                )}
                {debugNumImg && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Number Crop Feed (Binarized)</span>
                    <img src={debugNumImg} style={{ width: '100%', height: '28px', objectFit: 'contain', background: '#fff', borderRadius: '2px', border: '1px solid var(--border-glass-hover)' }} alt="Number Crop" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn btn-secondary" onClick={stopCamera} style={{ flex: 1 }}>
              Stop Camera
            </button>
            <button className="btn btn-primary" onClick={handleCapture} disabled={loading} style={{ flex: 2 }}>
              {loading ? 'Scanning...' : 'Capture & Identify'}
            </button>
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

      {/* Scan Results Suggestions List */}
      {scanMatches.length > 0 && (
        <div className="glass-panel" style={{ width: '100%' }}>
          <h3 style={{ fontSize: '1rem', color: '#fff', marginBottom: '1rem', borderLeft: '3px solid var(--accent-yellow)', paddingLeft: '0.5rem' }}>Select matching card:</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.75rem' }}>
            {scanMatches.map(card => (
              <div key={card.id} className="tcg-card" onClick={() => openQuickAdd(card)}>
                <div className="tcg-card-inner" style={{ border: '1px solid var(--border-glass-hover)' }}>
                  <img src={card.image_url} alt={card.name} className="tcg-card-image" />
                </div>
                <div className="tcg-card-info" style={{ textAlign: 'center' }}>
                  <div className="tcg-card-name" style={{ fontSize: '0.75rem' }}>{card.name}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-yellow)' }}>${card.price_trend ? card.price_trend.toFixed(2) : '0.00'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Drawer Overlay for Selected Card */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifycontent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ color: '#fff', fontSize: '1.25rem' }}>Add Scanned Card</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{selectedCard.name} ({selectedCard.set_name} • #{selectedCard.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
              <img src={selectedCard.image_url} alt={selectedCard.name} style={{ width: '80px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: 'var(--radius-sm)', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }} />
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>TCG MARKET PRICE</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>${selectedCard.price_trend ? selectedCard.price_trend.toFixed(2) : '0.00'}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Rarity: <span style={{ color: '#fff', fontWeight: 600 }}>{selectedCard.rarity}</span></div>
              </div>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div className="form-group">
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

                <div className="form-group">
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
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                <div className="form-group">
                  <label>Condition</label>
                  <select className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
                    <option value="Near Mint">Near Mint</option>
                    <option value="Lightly Played">Lightly Played</option>
                    <option value="Moderately Played">Moderately Played</option>
                    <option value="Heavily Played">Heavily Played</option>
                    <option value="Damaged">Damaged</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Printing</label>
                  <select className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
                    <option value="Normal">Normal</option>
                    <option value="Holofoil">Holofoil</option>
                    <option value="Reverse Holofoil">Reverse Holofoil</option>
                    <option value="1st Edition">1st Edition</option>
                    <option value="Promo">Promo</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Language</label>
                  <select className="select-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="English">English</option>
                    <option value="Japanese">Japanese</option>
                    <option value="German">German</option>
                    <option value="French">French</option>
                    <option value="Spanish">Spanish</option>
                    <option value="Italian">Italian</option>
                  </select>
                </div>
              </div>

              {/* Physical Location mapping inputs */}
              <div className="glass-panel" style={{ padding: '1rem', marginTop: '0.5rem', marginBottom: '1.25rem', background: 'rgba(0,0,0,0.2)' }}>
                <h4 style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Real-World Location Assignment</h4>
                
                <div className="form-group">
                  <label>Storage Container</label>
                  <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Unassigned Pile</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                    ))}
                  </select>
                </div>

                {locationId && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginTop: '0.75rem' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Page Number' : isBox ? 'Row Number / Letter' : 'Sub-Location 1'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Page 12' : isBox ? 'e.g. Row 2' : 'e.g. Top shelf'} 
                        value={subLocation1}
                        onChange={(e) => setSubLocation1(e.target.value)}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>{isBinder ? 'Slot Number (1-9)' : isBox ? 'Divider / Section' : 'Sub-Location 2'}</label>
                      <input 
                        type="text" 
                        className="input-control" 
                        placeholder={isBinder ? 'e.g. Slot 4' : isBox ? 'e.g. Behind Grass Divider' : 'e.g. Box A'} 
                        value={subLocation2}
                        onChange={(e) => setSubLocation2(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} style={{ flex: 1 }}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Add to Collection</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default CameraScanner;

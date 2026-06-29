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
  };

  // Preprocess cropped canvas for higher OCR accuracy (Greyscale + High Contrast)
  const getProcessedDataUrl = (video, sourceX, sourceY, sourceW, sourceH) => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceW * 2; // Upscale for clearer OCR resolution
    tempCanvas.height = sourceH * 2;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Apply heavy filters for OCR text extraction
    tempCtx.filter = 'grayscale(100%) contrast(250%) brightness(90%)';
    tempCtx.drawImage(
      video,
      sourceX, sourceY, sourceW, sourceH,
      0, 0, tempCanvas.width, tempCanvas.height
    );
    
    return tempCanvas.toDataURL('image/jpeg', 0.9);
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
      guideWidth = videoWidth * 0.70; // Matches width: 70% of stream
      guideHeight = guideWidth / cardAspectRatio; // guideWidth * 1.4
      guideLeft = (videoWidth - guideWidth) / 2;
      guideTop = (videoHeight - guideHeight) / 2;
    } else {
      // Landscape mode (typical desktop/webcam)
      guideHeight = videoHeight * 0.75; // Matches height: 75% of stream
      guideWidth = guideHeight * cardAspectRatio; // guideHeight * 0.7143
      guideLeft = (videoWidth - guideWidth) / 2;
      guideTop = (videoHeight - guideHeight) / 2;
    }

    // Name Crop: Top ~4% to 12% of the card's boundary
    const nameCrop = {
      x: Math.round(guideLeft + guideWidth * 0.05),
      y: Math.round(guideTop + guideHeight * 0.04),
      w: Math.round(guideWidth * 0.90),
      h: Math.round(guideHeight * 0.08)
    };

    // Number Crop: Bottom ~88% to 96% of the card's boundary (full width)
    const numCrop = {
      x: Math.round(guideLeft + guideWidth * 0.05),
      y: Math.round(guideTop + guideHeight * 0.88),
      w: Math.round(guideWidth * 0.90),
      h: Math.round(guideHeight * 0.08)
    };

    try {
      // 1. Process images
      const nameDataUrl = getProcessedDataUrl(video, nameCrop.x, nameCrop.y, nameCrop.w, nameCrop.h);
      const numDataUrl = getProcessedDataUrl(video, numCrop.x, numCrop.y, numCrop.w, numCrop.h);

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
          
          // Auto-open drawer if exactly one perfect match is found
          if (matches.length === 1) {
            stopCamera();
            openQuickAdd(matches[0]);
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
              <div className="scan-card-guide">
                <div className="scan-region-title"></div>
                <div className="scan-region-number"></div>
                {loading && <div className="scan-line"></div>}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginBottom: '0.25rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Auto-Capture Mode</span>
            <button 
              type="button"
              className={`btn ${autoScan ? 'btn-primary' : 'btn-secondary'}`} 
              onClick={() => setAutoScan(!autoScan)}
              style={{ padding: '0.35rem 1rem', fontSize: '0.8rem' }}
            >
              {autoScan ? 'ENABLED' : 'DISABLED'}
            </button>
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

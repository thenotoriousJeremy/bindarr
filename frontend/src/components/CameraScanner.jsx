import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, Plus, X, Search, Sparkles, Settings, ChevronLeft, ChevronRight, Library } from 'lucide-react';
import Tesseract from 'tesseract.js';
import confetti from 'canvas-confetti';
import { getCardDisplayName } from '../utils/langHelper';
import { translateJapaneseName } from '../utils/pokemonTranslation';
import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';

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
  const guideScale = 0.70; // Fixed guide box scale to ensure overlay matches scans perfectly
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

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [locations, setLocations] = useState([]);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  const [drawerTouchStart, setDrawerTouchStart] = useState(null);
  const [drawerTouchEnd, setDrawerTouchEnd] = useState(null);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [subLocation1, setSubLocation1] = useState('');
  const [subLocation2, setSubLocation2] = useState('');

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
        if (data.length > 0) {
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
        
        // Append to recent scans history log
        setRecentScans(prev => [card, ...prev].slice(0, 10));
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
  const getProcessedDataUrl = (sourceCanvas, sourceX, sourceY, sourceW, sourceH) => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceW * 4; // Upscale by 4x for high-res OCR on small text
    tempCanvas.height = sourceH * 4;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Enable high-quality image smoothing for clean bicubic interpolation
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';
    
    // Draw raw cropped frame first
    tempCtx.drawImage(
      sourceCanvas,
      sourceX, sourceY, sourceW, sourceH,
      0, 0, tempCanvas.width, tempCanvas.height
    );
    
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

    // Define crops in screen coordinates matching the selected cardLayout:
    let nameCropScreen, numLeftCropScreen = null, numRightCropScreen = null;

    if (cardLayout === 'trainer') {
      // Trainer card name is lower down and wider
      nameCropScreen = {
        x: (guideRect.left - videoRect.left) + guideRect.width * 0.04,
        y: (guideRect.top - videoRect.top) + guideRect.height * 0.11,
        w: guideRect.width * 0.75,
        h: guideRect.height * 0.07
      };
    } else {
      // Standard name crop (Modern, Vintage, Japanese)
      nameCropScreen = {
        x: (guideRect.left - videoRect.left) + guideRect.width * 0.04,
        y: (guideRect.top - videoRect.top) + guideRect.height * 0.035,
        w: guideRect.width * 0.55,
        h: guideRect.height * 0.06
      };
    }

    if (cardLayout === 'modern' || cardLayout === 'trainer' || cardLayout === 'japanese') {
      // Left bottom number (Japanese Modern starts closer to left border at 4%)
      numLeftCropScreen = {
        x: (guideRect.left - videoRect.left) + guideRect.width * (cardLayout === 'japanese' ? 0.04 : 0.10),
        y: (guideRect.top - videoRect.top) + guideRect.height * 0.90, // Starts at 90% Y instead of 93.5%
        w: guideRect.width * 0.22, // Taller and wider box
        h: guideRect.height * 0.065
      };
    }

    if (cardLayout === 'vintage' || cardLayout === 'trainer' || cardLayout === 'japanese') {
      // Right bottom number (Vintage, Japanese Vintage)
      numRightCropScreen = {
        x: (guideRect.left - videoRect.left) + guideRect.width * 0.66,
        y: (guideRect.top - videoRect.top) + guideRect.height * 0.90, // Starts at 90% Y instead of 93.5%
        w: guideRect.width * 0.22, // Taller and wider box
        h: guideRect.height * 0.065
      };
    }

    // Scale screen coordinates to the oriented canvas coordinates
    const nameCrop = {
      x: Math.round(nameCropScreen.x * scaleX),
      y: Math.round(nameCropScreen.y * scaleY),
      w: Math.round(nameCropScreen.w * scaleX),
      h: Math.round(nameCropScreen.h * scaleY)
    };

    const numLeftCrop = numLeftCropScreen ? {
      x: Math.round(numLeftCropScreen.x * scaleX),
      y: Math.round(numLeftCropScreen.y * scaleY),
      w: Math.round(numLeftCropScreen.w * scaleX),
      h: Math.round(numLeftCropScreen.h * scaleY)
    } : null;

    const numRightCrop = numRightCropScreen ? {
      x: Math.round(numRightCropScreen.x * scaleX),
      y: Math.round(numRightCropScreen.y * scaleY),
      w: Math.round(numRightCropScreen.w * scaleX),
      h: Math.round(numRightCropScreen.h * scaleY)
    } : null;

    try {
      // 2. Process crop images using the oriented canvas
      const nameDataUrl = getProcessedDataUrl(orientedCanvas, nameCrop.x, nameCrop.y, nameCrop.w, nameCrop.h);
      setDebugNameImg(nameDataUrl);

      let numLeftDataUrl = '';
      if (numLeftCrop) {
        numLeftDataUrl = getProcessedDataUrl(orientedCanvas, numLeftCrop.x, numLeftCrop.y, numLeftCrop.w, numLeftCrop.h);
        setDebugNumLeftImg(numLeftDataUrl);
      } else {
        setDebugNumLeftImg('');
      }

      let numRightDataUrl = '';
      if (numRightCrop) {
        numRightDataUrl = getProcessedDataUrl(orientedCanvas, numRightCrop.x, numRightCrop.y, numRightCrop.w, numRightCrop.h);
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
      const nameRaw = nameResult.data.text.trim();
      
      let detectedName = '';
      if (cardLayout === 'japanese') {
        detectedName = translateJapaneseName(nameRaw);
        console.log(`Japanese OCR Read: "${nameRaw}" -> Translated: "${detectedName}"`);
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
        setScanStatus('Search failed. Server error.');
        setScanFlash('error');
        setTimeout(() => setScanFlash(null), 1500);
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
    setSubLocation1('');
    setSubLocation2('');
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
        
        // Append to recent scans history
        setRecentScans(prev => [selectedCard, ...prev].slice(0, 10));

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
            style={videoRatio ? { aspectRatio: `${videoRatio}` } : {}}
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
                  width: `${guideScale * 100}%`,
                  animation: scanFlash === 'success' ? 'border-flash-success 1.5s ease-in-out' : scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {/* Name Guide: shift lower and widen if trainer layout */}
                <div 
                  className="scan-region-title" 
                  style={cardLayout === 'trainer' ? { top: '11%', height: '7%', width: '75%' } : {}}
                />
                
                {/* Left Number Guide: show for Modern, Trainer, Japanese (custom left positioning for Japanese) */}
                {(cardLayout === 'modern' || cardLayout === 'trainer' || cardLayout === 'japanese') && (
                  <div 
                    className="scan-region-number-left" 
                    style={cardLayout === 'japanese' ? { left: '4%' } : {}}
                  />
                )}
                
                {/* Right Number Guide: show for Vintage, Trainer, Japanese */}
                {(cardLayout === 'vintage' || cardLayout === 'trainer' || cardLayout === 'japanese') && (
                  <div className="scan-region-number-right" />
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

              {/* Card Layout Selection */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', background: 'rgba(0,0,0,0.15)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Card Layout Mode</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.25rem', marginTop: '0.15rem' }}>
                  {['modern', 'vintage', 'trainer', 'japanese'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`btn ${cardLayout === mode ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ padding: '0.35rem 0', fontSize: '0.7rem', textTransform: 'capitalize' }}
                      onClick={() => setCardLayout(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Manual OCR Correction / Quick Search panel - Always visible when camera is active */}
          {cameraActive && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Quick Identify (Scan or Type below)
              </div>
              <form onSubmit={handleManualSearch} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                <div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Card Name</span>
                  <input 
                    type="text" 
                    className="input-control" 
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }} 
                    value={scannedName}
                    onChange={(e) => setScannedName(e.target.value)}
                    placeholder="e.g. Charizard..."
                  />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Collector No.</span>
                  <input 
                    type="text" 
                    className="input-control" 
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }} 
                    value={scannedNumber}
                    onChange={(e) => setScannedNumber(e.target.value)}
                    placeholder="e.g. 4/102..."
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
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--type-grass)', background: 'rgba(74, 222, 128, 0.1)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>Added</span>
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
              <div className="quick-add-grid">
                
                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img 
                    src={selectedCard.image_url} 
                    alt={selectedCard.name} 
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      ${formatPrice(selectedCard.price_trend)}
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

                {/* Column 3: Location Assignment Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">Location Assignment</div>
                  
                  <div className="quick-add-fields-group">
                    <div className="form-group quick-add-full-width" style={{ marginBottom: 0 }}>
                      <label>Storage Container</label>
                      <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                        <option value="">Unassigned Pile</option>
                        {locations.map((loc) => (
                          <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {locationId && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
                      <div className="quick-add-fields-group">
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: '0.7rem' }}>{isBinder ? 'Page' : isBox ? 'Row' : 'Sub-Loc 1'}</label>
                          <input 
                            type="text" 
                            className="input-control" 
                            placeholder={isBinder ? 'Page No.' : isBox ? 'Row No.' : 'Sub 1'} 
                            value={subLocation1}
                            onChange={(e) => setSubLocation1(e.target.value)}
                            style={{ padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: '0.7rem' }}>{isBinder ? 'Slot' : isBox ? 'Divider' : 'Sub-Loc 2'}</label>
                          <input 
                            type="text" 
                            className="input-control" 
                            placeholder={isBinder ? 'Slot No.' : isBox ? 'Section' : 'Sub 2'} 
                            value={subLocation2}
                            onChange={(e) => setSubLocation2(e.target.value)}
                            style={{ padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
                          />
                        </div>
                      </div>

                      {/* Visual 3x3 Binder slot selector */}
                      {isBinder && (() => {
                        const pageNum = parseInt((subLocation1 || '').replace(/\D/g, ''), 10) || 1;
                        const handleSetPage = (p) => {
                          setSubLocation1(`Page ${p}`);
                        };
                        const handleDrawerTouchStart = (e) => {
                          setDrawerTouchStart(e.targetTouches[0].clientX);
                        };
                        const handleDrawerTouchMove = (e) => {
                          setDrawerTouchEnd(e.targetTouches[0].clientX);
                        };
                        const handleDrawerTouchEnd = () => {
                          if (!drawerTouchStart || !drawerTouchEnd) return;
                          const distance = drawerTouchStart - drawerTouchEnd;
                          if (distance > 50) {
                            handleSetPage(Math.min(pageNum + 1, 30));
                          } else if (distance < -50) {
                            handleSetPage(Math.max(pageNum - 1, 1));
                          }
                          setDrawerTouchStart(null);
                          setDrawerTouchEnd(null);
                        };

                        return (
                          <div 
                            style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginTop: '0.15rem' }}
                            onTouchStart={handleDrawerTouchStart}
                            onTouchMove={handleDrawerTouchMove}
                            onTouchEnd={handleDrawerTouchEnd}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '2px', userSelect: 'none' }}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-icon-only"
                                onClick={() => handleSetPage(Math.max(pageNum - 1, 1))}
                                disabled={pageNum === 1}
                                style={{ padding: 0, width: '22px', height: '22px', minHeight: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: pageNum === 1 ? 0.3 : 1 }}
                              >
                                <ChevronLeft size={10} />
                              </button>
                              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>Page {pageNum}</span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-icon-only"
                                onClick={() => handleSetPage(Math.min(pageNum + 1, 30))}
                                disabled={pageNum === 30}
                                style={{ padding: 0, width: '22px', height: '22px', minHeight: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: pageNum === 30 ? 0.3 : 1 }}
                              >
                                <ChevronRight size={10} />
                              </button>
                            </div>
                            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Visual Slot (Swipe/Tap)</label>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.35rem', width: '150px', background: 'rgba(0,0,0,0.3)', padding: '0.4rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => {
                                const slotLabel = `Slot ${num}`;
                                const isSelected = subLocation2 === slotLabel || subLocation2 === String(num);
                                return (
                                  <button
                                    key={num}
                                    type="button"
                                    onClick={() => setSubLocation2(slotLabel)}
                                    style={{
                                      aspectRatio: 0.718,
                                      background: isSelected ? 'var(--accent-red)' : 'rgba(255,255,255,0.03)',
                                      border: isSelected ? '1px solid var(--accent-red)' : '1px solid var(--border-glass)',
                                      borderRadius: 'var(--radius-xs)',
                                      color: isSelected ? '#fff' : 'var(--text-secondary)',
                                      fontSize: '0.7rem',
                                      fontWeight: '700',
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      boxShadow: isSelected ? '0 0 8px rgba(255, 71, 71, 0.4)' : 'none',
                                      transition: 'all 0.15s ease'
                                    }}
                                  >
                                    {num}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
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

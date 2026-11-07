import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { binderSpread } from '../utils/cardOptions';
import { pageGrid, layoutPockets } from '../utils/binderLayout';
import {
  PAPERS, PRINT_DPI, pocketPresetFor, pageGeometry, compositionOf, coverTransform, fullMask, remapMask,
  artworkSlices, pocketImageStyle, pieceMatrix, pieceSizePx, packInserts,
} from '../utils/binderArtGeometry';
import BinderArtPiece from './BinderArtPiece';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';

// Upload, place and print artwork for one binder page or spread (issue #104).
//
// The picture is a floating layer in millimetres; pockets toggle between showing
// it and keeping a card. Printing cuts the artwork pockets into separate pieces
// with a canvas at 300 dpi and lays them out at actual size on A4 or Letter,
// printed through window.print() and an @page rule, so there is no PDF library:
// "Save as PDF" in the print dialog is the PDF.

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 12 * 1024 * 1024;
const tileKey = (tile) => `${tile.side}-${tile.row}-${tile.col}`;

// A millimetre field that only commits a valid number, on blur or Enter, so
// typing "6" on the way to "63" does not clamp halfway.
function MmInput({ label, value, min, max, step = 0.5, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
    else setText(String(value));
  };
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
      {label}
      <input
        className="input-control"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        style={{ width: '5.5rem', padding: '0.25rem 0.4rem', fontSize: '0.75rem' }}
      />
    </label>
  );
}

function PrintSheet({ sheet, pieces, labelFor }) {
  // Half a millimetre short of the paper, so rounding never spills a sheet onto
  // a second, blank page.
  const h = sheet.heightMm - 0.5;
  const m = sheet.markerY;
  return (
    <section className="binder-print-sheet" style={{ width: `${sheet.widthMm}mm`, height: `${h}mm` }}>
      {sheet.tiles.map(tile => pieces[tileKey(tile)] && (
        <img
          key={tileKey(tile)}
          src={pieces[tileKey(tile)]}
          alt=""
          style={{ left: `${tile.x}mm`, top: `${tile.y}mm`, width: `${tile.widthMm}mm`, height: `${tile.heightMm}mm` }}
        />
      ))}
      <svg
        width={`${sheet.widthMm}mm`}
        height={`${h}mm`}
        viewBox={`0 0 ${sheet.widthMm} ${h}`}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden="true"
      >
        {sheet.tiles.flatMap(tile => tile.guides.map((g, i) => (
          <line key={`${tileKey(tile)}-${i}`} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#000" strokeWidth="0.2" />
        )))}
        {sheet.tiles.filter(tile => tile.label).map(tile => (
          <text key={`${tileKey(tile)}-label`} x={tile.label.x + tile.label.widthMm / 2} y={tile.label.y + 2} fontSize="2.2" textAnchor="middle" fill="#000">
            {labelFor(tile)}
          </text>
        ))}
        <line x1={sheet.markerX} y1={m} x2={sheet.markerX + sheet.markerMm} y2={m} stroke="#000" strokeWidth="0.3" />
        <line x1={sheet.markerX} y1={m - 1.5} x2={sheet.markerX} y2={m + 1.5} stroke="#000" strokeWidth="0.3" />
        <line x1={sheet.markerX + sheet.markerMm} y1={m - 1.5} x2={sheet.markerX + sheet.markerMm} y2={m + 1.5} stroke="#000" strokeWidth="0.3" />
        <text x={sheet.markerX + sheet.markerMm + 2} y={m + 1} fontSize="2.6" fill="#000">{`${sheet.markerMm} mm`}</text>
      </svg>
    </section>
  );
}

function BinderArtworkEditor({ location, compartments, pageIndex, cardsByCompartment, layers, onClose, onSaved, showToast }) {
  const { t } = useT();
  const { leftIdx, rightIdx } = binderSpread(Math.min(pageIndex, compartments.length - 1));
  const left = leftIdx >= 0 ? compartments[leftIdx] || null : null;
  const right = compartments[rightIdx] || null;
  const targets = [left && 'left', right && 'right', left && right && 'spread'].filter(Boolean);
  const layerFor = (page) => (page ? layers.find(l => l.compartment_id === page.id) || null : null);

  const initialTarget = () => {
    const onLeft = layerFor(left);
    if (onLeft) return onLeft.spread && right ? 'spread' : 'left';
    if (layerFor(right)) return 'right';
    return targets[0];
  };
  const [target, setTarget] = useState(initialTarget);
  const anchor = target === 'right' ? right : left;
  const facing = target === 'spread' ? right : null;

  // Everything that is saved, as one value so "unsaved changes" is one compare.
  const stateFor = (tgt) => {
    const page = tgt === 'right' ? right : left;
    const layer = layerFor(page);
    const preset = pocketPresetFor(location.type);
    if (!layer) {
      return { artwork: null, transform: null, mask: [], pocket: { widthMm: preset.widthMm, heightMm: preset.heightMm, gapMm: preset.gapMm } };
    }
    return {
      artwork: { id: layer.artwork_id, width: layer.width, height: layer.height },
      transform: { xMm: layer.x_mm, yMm: layer.y_mm, widthMm: layer.width_mm, rotationDeg: layer.rotation_deg },
      mask: layer.mask,
      pocket: { widthMm: layer.pocket_w_mm, heightMm: layer.pocket_h_mm, gapMm: layer.gap_mm },
    };
  };
  const [draft, setDraft] = useState(() => stateFor(initialTarget()));
  const [saved, setSaved] = useState(() => JSON.stringify({ target: initialTarget(), ...stateFor(initialTarget()) }));
  const { artwork, transform, mask, pocket } = draft;
  const patch = (next) => setDraft(d => ({ ...d, ...next }));

  const [mode, setMode] = useState('place');
  const [paperId, setPaperId] = useState('a4');
  const [labels, setLabels] = useState(true);
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState('');
  const [pieces, setPieces] = useState({});
  const press = useRef(null);

  const pageOf = (page) => (page ? pageGeometry({ ...pageGrid(page.capacity, location.page_columns), ...pocket }) : null);
  const anchorPage = pageOf(anchor);
  const facingPage = pageOf(facing);
  const composition = anchorPage ? compositionOf(anchorPage, facingPage, !!facingPage) : null;
  const compKey = composition ? JSON.stringify(composition) : '';
  const slices = useMemo(
    () => (compKey ? artworkSlices({ composition: JSON.parse(compKey), mask }) : []),
    [compKey, mask]
  );
  const paper = PAPERS[paperId];
  const packed = useMemo(() => packInserts({ slices, paper, labels }), [slices, paper, labels]);

  // A page whose layout changed since the save keeps only pockets that exist.
  useEffect(() => {
    if (!compKey) return;
    const kept = remapMask(mask, JSON.parse(compKey));
    if (kept.length !== mask.length) {
      setDraft(d => ({ ...d, mask: kept }));
      showToast(t('binderArt.layoutChanged'));
    }
  }, [compKey, mask, showToast, t]);

  // The picture behind the bearer token, as a blob URL.
  const artworkId = artwork?.id;
  useEffect(() => {
    if (!artworkId) {
      setSrc('');
      return undefined;
    }
    let stop = false;
    let url = '';
    (async () => {
      const res = await fetch(`/api/binder-art/${artworkId}/image`);
      if (!res.ok || stop) return;
      const blob = await res.blob();
      if (stop) return;
      url = URL.createObjectURL(blob);
      setSrc(url);
    })().catch(() => {});
    return () => {
      stop = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artworkId]);

  // Cut the artwork pockets into separate pieces at print resolution. Drawing
  // the whole picture through each pocket's matrix and letting the canvas clip
  // is the crop; JPEG keeps a sheet of them light, so the canvas is filled white
  // first (an uncovered corner prints as paper, not black).
  useEffect(() => {
    if (mode !== 'print' || !src || !artwork || !transform) {
      setPieces({});
      return undefined;
    }
    let stop = false;
    const made = [];
    const img = new Image();
    img.onload = async () => {
      const next = {};
      for (const slice of slices) {
        const size = pieceSizePx(slice, PRINT_DPI);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.setTransform(...pieceMatrix({ pocket: slice, transform, image: artwork, dpi: PRINT_DPI }));
        ctx.drawImage(img, 0, 0, artwork.width, artwork.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        if (stop) return;
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        made.push(url);
        next[tileKey(slice)] = url;
      }
      if (!stop) setPieces(next);
    };
    img.src = src;
    return () => {
      stop = true;
      made.forEach(u => URL.revokeObjectURL(u));
    };
  }, [mode, src, artwork, transform, slices]);

  // Only while the print view is open does the page print as inserts.
  useEffect(() => {
    document.body.classList.toggle('binder-art-printing', mode === 'print');
    return () => document.body.classList.remove('binder-art-printing');
  }, [mode]);

  const dirty = JSON.stringify({ target, ...draft }) !== saved;

  const switchTarget = (next) => {
    if (next === target) return;
    if (dirty && !window.confirm(t('binderArt.confirmClose'))) return;
    const loaded = stateFor(next);
    setTarget(next);
    setDraft(loaded);
    setSaved(JSON.stringify({ target: next, ...loaded }));
  };

  const close = () => {
    if (dirty && !window.confirm(t('binderArt.confirmClose'))) return;
    onClose();
  };

  const upload = async (file) => {
    if (!file || !composition) return;
    if (!TYPES.includes(file.type)) return showToast(t('binderArt.errType'));
    if (file.size > MAX_BYTES) return showToast(t('binderArt.errSize'));
    setBusy(true);
    try {
      const res = await fetch('/api/binder-art', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('binderArt.errUpload'));
      const next = data.artwork;
      patch({
        artwork: { id: next.id, width: next.width, height: next.height },
        transform: coverTransform(composition, next.width / next.height),
        // Keep the pockets already chosen when replacing the picture.
        mask: artwork ? mask : fullMask(composition),
      });
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!artwork || !transform || !anchor) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/compartments/${anchor.id}/binder-art`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artwork_id: artwork.id,
          x_mm: transform.xMm,
          y_mm: transform.yMm,
          width_mm: transform.widthMm,
          rotation_deg: transform.rotationDeg,
          spread: target === 'spread',
          mask,
          pocket_w_mm: pocket.widthMm,
          pocket_h_mm: pocket.heightMm,
          gap_mm: pocket.gapMm,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('binderArt.errSave'));
      setSaved(JSON.stringify({ target, ...draft }));
      onSaved();
      showToast(t('binderArt.saved'));
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!anchor || !window.confirm(t('binderArt.confirmRemove'))) return;
    const stored = layerFor(anchor);
    if (!stored) {
      // Never saved: just drop the draft.
      setDraft(d => ({ ...d, artwork: null, transform: null, mask: [] }));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/compartments/${anchor.id}/binder-art`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('binderArt.errSave'));
      const empty = { artwork: null, transform: null, mask: [], pocket };
      setDraft(empty);
      setSaved(JSON.stringify({ target, ...empty }));
      onSaved();
      showToast(t('binderArt.removed'));
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePocket = (side, row, col) => {
    const has = mask.some(e => e.side === side && e.row === row && e.col === col);
    patch({ mask: has ? mask.filter(e => !(e.side === side && e.row === row && e.col === col)) : [...mask, { side, row, col }] });
  };

  // Drag moves the picture; a press that does not move toggles the pocket under it.
  const onPointerDown = (e) => {
    if (!composition) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      origin: transform,
      mmPerPx: composition.widthMm / bounds.width,
      moved: false,
      pocket: e.target.closest('[data-pocket]'),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const s = press.current;
    if (!s || s.id !== e.pointerId || !s.origin) return;
    if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return;
    s.moved = true;
    patch({ transform: { ...s.origin, xMm: s.origin.xMm + (e.clientX - s.x) * s.mmPerPx, yMm: s.origin.yMm + (e.clientY - s.y) * s.mmPerPx } });
  };
  const onPointerUp = (e) => {
    const s = press.current;
    if (!s || s.id !== e.pointerId) return;
    press.current = null;
    if (s.moved || !s.pocket) return;
    togglePocket(s.pocket.dataset.side, Number(s.pocket.dataset.row), Number(s.pocket.dataset.col));
  };
  const onStageKey = (e) => {
    if (!transform) return;
    const step = e.shiftKey ? 5 : 1;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!move) return;
    e.preventDefault();
    patch({ transform: { ...transform, xMm: transform.xMm + move[0], yMm: transform.yMm + move[1] } });
  };

  const pageCards = (page) => (page ? layoutPockets(cardsByCompartment.get(page.id) || [], page.capacity, !!location.allow_stacking) : []);
  const cardsBySide = { left: pageCards(anchor), right: pageCards(facing) };
  const pageBySide = { left: anchor, right: facing };
  const labelFor = (tile) => t('binderArt.label', {
    page: pageBySide[tile.side]?.display_label || '',
    row: tile.row + 1,
    col: tile.col + 1,
  });

  const pct = (mm, total) => `${(mm / total) * 100}%`;
  const maxWidthMm = composition ? Math.ceil(Math.max(composition.widthMm, composition.heightMm) * 3) : 1000;
  const targetLabel = (key) => t(`binderArt.target.${key}`);

  return (
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="glass-panel" role="dialog" aria-label={t('binderArt.title')} style={{ width: 'min(1100px, 100%)', maxHeight: '100%', overflow: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '14rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-strong)' }}>{t('binderArt.title')}</h2>
            <p style={{ margin: '0.2rem 0 0', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{t(mode === 'print' ? 'binderArt.printHint' : 'binderArt.hint')}</p>
          </div>
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {['place', 'print'].map(id => (
              <button key={id} type="button" className={`btn ${mode === id ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }} onClick={() => setMode(id)} disabled={id === 'print' && !artwork}>
                {t(`binderArt.mode.${id}`)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-secondary btn-icon-only" onClick={close} aria-label={t('binderArt.close')} title={t('binderArt.close')} style={{ width: '30px', height: '30px', padding: 0 }}>
            <X size={16} />
          </button>
        </div>

        {mode === 'place' && (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {targets.length > 1 && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                  {t('binderArt.target')}
                  <select className="select-control" value={target} onChange={(e) => switchTarget(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}>
                    {targets.map(key => <option key={key} value={key}>{targetLabel(key)}</option>)}
                  </select>
                </label>
              )}
              <label className="btn btn-secondary" style={{ cursor: busy ? 'wait' : 'pointer', fontSize: '0.75rem', padding: '0.35rem 0.7rem' }} title={t('binderArt.uploadHint')}>
                {t(artwork ? 'binderArt.replace' : 'binderArt.upload')}
                <input
                  type="file"
                  accept={TYPES.join(',')}
                  hidden
                  disabled={busy}
                  onChange={(e) => { const file = e.target.files && e.target.files[0]; e.target.value = ''; upload(file); }}
                />
              </label>
              <MmInput label={t('binderArt.pocketW')} value={pocket.widthMm} min={20} max={200} onCommit={(v) => patch({ pocket: { ...pocket, widthMm: v } })} />
              <MmInput label={t('binderArt.pocketH')} value={pocket.heightMm} min={20} max={200} onCommit={(v) => patch({ pocket: { ...pocket, heightMm: v } })} />
              <MmInput label={t('binderArt.gap')} value={pocket.gapMm} min={0} max={30} onCommit={(v) => patch({ pocket: { ...pocket, gapMm: v } })} />
            </div>

            {transform && (
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: '1 1 14rem' }}>
                  {t('binderArt.width')}
                  <input type="range" min="10" max={maxWidthMm} step="1" value={Math.round(transform.widthMm)} onChange={(e) => patch({ transform: { ...transform, widthMm: Number(e.target.value) } })} style={{ flex: 1 }} />
                  <span style={{ minWidth: '3.5rem', textAlign: 'right' }}>{Math.round(transform.widthMm)} mm</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: '1 1 12rem' }}>
                  {t('binderArt.rotation')}
                  <input type="range" min="-180" max="180" step="1" value={Math.round(transform.rotationDeg > 180 ? transform.rotationDeg - 360 : transform.rotationDeg)} onChange={(e) => patch({ transform: { ...transform, rotationDeg: Number(e.target.value) } })} style={{ flex: 1 }} />
                  <span style={{ minWidth: '2.5rem', textAlign: 'right' }}>{Math.round(transform.rotationDeg > 180 ? transform.rotationDeg - 360 : transform.rotationDeg)}°</span>
                </label>
                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.25rem 0.6rem' }} onClick={() => patch({ transform: coverTransform(composition, artwork.width / artwork.height) })}>
                  {t('binderArt.fill')}
                </button>
              </div>
            )}

            {composition && (
              <div
                className="binder-art-stage"
                tabIndex={0}
                onKeyDown={onStageKey}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                  width: `min(100%, calc(58vh * ${composition.widthMm / composition.heightMm}))`,
                  aspectRatio: `${composition.widthMm} / ${composition.heightMm}`,
                  cursor: transform ? 'grab' : 'default',
                }}
              >
                {src && transform && (
                  <img
                    className="binder-art-ghost"
                    src={src}
                    alt=""
                    draggable="false"
                    style={{
                      left: pct(transform.xMm, composition.widthMm),
                      top: pct(transform.yMm, composition.heightMm),
                      width: pct(transform.widthMm, composition.widthMm),
                      transform: `translate(-50%, -50%) rotate(${transform.rotationDeg}deg)`,
                    }}
                  />
                )}
                {composition.pages.flatMap(placed => Array.from({ length: placed.page.rows * placed.page.columns }, (_, i) => {
                  const row = Math.floor(i / placed.page.columns);
                  const col = i % placed.page.columns;
                  const x = placed.originX + col * (placed.page.pocketWidthMm + placed.page.gapMm);
                  const y = placed.originY + row * (placed.page.pocketHeightMm + placed.page.gapMm);
                  const rect = { x, y, widthMm: placed.page.pocketWidthMm, heightMm: placed.page.pocketHeightMm };
                  const isArt = mask.some(e => e.side === placed.side && e.row === row && e.col === col);
                  const card = cardsBySide[placed.side][i];
                  return (
                    <div
                      key={`${placed.side}-${i}`}
                      data-pocket
                      data-side={placed.side}
                      data-row={row}
                      data-col={col}
                      className={`binder-art-pocket ${isArt ? 'is-art' : ''}`}
                      title={t(isArt ? 'binderArt.pocketArt' : 'binderArt.pocketCard')}
                      style={{ left: pct(x, composition.widthMm), top: pct(y, composition.heightMm), width: pct(rect.widthMm, composition.widthMm), height: pct(rect.heightMm, composition.heightMm) }}
                    >
                      {isArt && transform && <BinderArtPiece src={src} style={pocketImageStyle(rect, transform)} />}
                      {!isArt && card && <CardImage card={card} className="binder-art-card" alt="" draggable="false" />}
                      {!isArt && !card && t('binderArt.card')}
                    </div>
                  );
                }))}
                {!artwork && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--text-strong)', fontSize: '0.85rem', fontWeight: 600 }}>
                    {t('binderArt.empty')}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {mode === 'print' && (
          <>
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                {t('binderArt.paper')}
                <select className="select-control" value={paperId} onChange={(e) => setPaperId(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}>
                  {Object.values(PAPERS).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
                {t('binderArt.labels')}
              </label>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '0.75rem', padding: '0.35rem 0.8rem', marginLeft: 'auto' }}
                disabled={!slices.length || Object.keys(pieces).length < slices.length - packed.rejected.length}
                onClick={() => window.print()}
              >
                {t('binderArt.print')}
              </button>
            </div>
            {!slices.length && <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('binderArt.noPockets')}</p>}
            {packed.rejected.length > 0 && <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{t('binderArt.tooBig', { count: packed.rejected.length })}</p>}
            {slices.length > 0 && Object.keys(pieces).length === 0 && <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('binderArt.preparing')}</p>}
            <div className="binder-art-sheets">
              {packed.sheets.map((sheet, i) => <PrintSheet key={i} sheet={sheet} pieces={pieces} labelFor={labelFor} />)}
            </div>
            {createPortal(
              <div className="binder-print-root">
                <style>{`@media print { @page { size: ${paper.cssSize} portrait; margin: 0; } }`}</style>
                {packed.sheets.map((sheet, i) => <PrintSheet key={i} sheet={sheet} pieces={pieces} labelFor={labelFor} />)}
              </div>,
              document.body
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {artwork && (
            <button type="button" className="btn btn-danger" style={{ fontSize: '0.75rem', marginRight: 'auto' }} disabled={busy} onClick={remove}>
              {t('binderArt.remove')}
            </button>
          )}
          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={close}>{t('binderArt.close')}</button>
          <button type="button" className="btn btn-primary" style={{ fontSize: '0.75rem' }} disabled={!artwork || busy || !dirty} onClick={save}>{t('binderArt.save')}</button>
        </div>
      </div>
    </div>
  );
}

export default BinderArtworkEditor;

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { windowRange, trackCount, measureStride, rowOffset } from '../utils/windowing';

// The nearest ancestor that scrolls vertically, or null for the page itself.
// The collection scrolls the window; the Unsorted queue scrolls its own column
// on a wide screen and the window on a phone, so this is looked up, not assumed.
function scrollParent(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// Renders only the items near the viewport out of a long list, with padding
// (or spacer rows, for a table body) standing in for the rest — see
// utils/windowing.js. `as` is the container element; it keeps `className` and
// `style`, so a CSS grid stays a CSS grid and its columns are read back from
// the browser rather than computed here. renderItem(item, index) must return
// one element per item (the measurement reads the container's children), and
// should be a stable callback over memoized tiles: a scroll then mounts the
// rows coming into view and nothing else re-renders.
//
// The ref exposes scrollToIndex(i), for a caller that has to bring an
// unmounted item into view (locating a card).
const VirtualGrid = forwardRef(function VirtualGrid(
  { items, renderItem, as: Tag = 'div', className, style, spacer = 'padding', spacerColSpan = 1, overscanRows = 3 },
  ref
) {
  const elRef = useRef(null);
  const [metrics, setMetrics] = useState({ cols: 1, stride: 0 });
  const [view, setView] = useState({ top: 0, bottom: typeof window !== 'undefined' ? window.innerHeight : 800 });
  const count = items.length;
  const range = windowRange({ count, cols: metrics.cols, stride: metrics.stride, viewTop: view.top, viewBottom: view.bottom, overscanRows });

  const readView = useCallback(() => {
    const el = elRef.current;
    if (!el || !el.offsetParent) return; // hidden tab: nothing to measure
    const rect = el.getBoundingClientRect();
    const scroller = scrollParent(el);
    const vpTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const vpBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    // Relative to the first row: the container's own top padding is the
    // spacer, so it is part of the coordinate system rather than subtracted.
    const top = vpTop - rect.top;
    const bottom = vpBottom - rect.top;
    setView(prev => {
      // Re-render only when the mounted rows would actually change.
      if (!metrics.stride) return Math.abs(prev.top - top) < 1 && Math.abs(prev.bottom - bottom) < 1 ? prev : { top, bottom };
      const next = windowRange({ count, cols: metrics.cols, stride: metrics.stride, viewTop: top, viewBottom: bottom, overscanRows });
      const cur = windowRange({ count, cols: metrics.cols, stride: metrics.stride, viewTop: prev.top, viewBottom: prev.bottom, overscanRows });
      return next.start === cur.start && next.end === cur.end ? prev : { top, bottom };
    });
  }, [count, metrics, overscanRows]);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el || !el.offsetParent) return;
    const cs = getComputedStyle(el);
    const cols = cs.display.includes('grid') ? trackCount(cs.gridTemplateColumns) : 1;
    const kids = Array.from(el.children).filter(k => !k.hasAttribute('data-win-spacer'));
    const tops = [];
    for (let i = 0; i < kids.length; i += cols) tops.push(kids[i].getBoundingClientRect().top);
    const rowGap = parseFloat(cs.rowGap) || 0;
    const stride = measureStride(tops, kids[0] ? kids[0].getBoundingClientRect().height : 0, rowGap);
    setMetrics(prev => (prev.cols === cols && Math.abs(prev.stride - stride) < 0.5 ? prev : { cols, stride }));
  }, []);

  // After every commit: the mounted rows may have changed size or columns.
  useLayoutEffect(() => { measure(); });
  useLayoutEffect(() => { readView(); }, [readView]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    // Once per frame; the timer is the fallback for a page that is not being
    // painted (rAF never fires then), whichever comes first runs.
    let frame = 0;
    let timer = 0;
    const run = () => {
      cancelAnimationFrame(frame); clearTimeout(timer);
      frame = 0; timer = 0;
      readView();
    };
    const onScroll = () => {
      if (frame || timer) return;
      frame = requestAnimationFrame(run);
      timer = setTimeout(run, 100);
    };
    // Capture catches the scroll of any ancestor, whichever one it turns out to be.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    // Also fires when a hidden tab is shown again (0 → real size).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { measure(); onScroll(); }) : null;
    if (ro) ro.observe(el);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (ro) ro.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [readView, measure]);

  useImperativeHandle(ref, () => ({
    scrollToIndex(index) {
      const el = elRef.current;
      if (!el || index < 0) return;
      const stride = metrics.stride || 0;
      const scroller = scrollParent(el);
      const rect = el.getBoundingClientRect();
      const target = rowOffset(index, metrics.cols, stride);
      if (scroller) {
        scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top + target - scroller.clientHeight / 3;
      } else {
        window.scrollTo({ top: window.scrollY + rect.top + target - window.innerHeight / 3 });
      }
    },
  }), [metrics]);

  const slice = items.slice(range.start, range.end);
  if (spacer === 'rows') {
    return (
      <Tag ref={elRef} className={className} style={style}>
        {range.padTop > 0 && <tr data-win-spacer="" aria-hidden="true" style={{ height: range.padTop }}><td colSpan={spacerColSpan} style={{ padding: 0, border: 0 }} /></tr>}
        {slice.map((item, i) => renderItem(item, range.start + i))}
        {range.padBottom > 0 && <tr data-win-spacer="" aria-hidden="true" style={{ height: range.padBottom }}><td colSpan={spacerColSpan} style={{ padding: 0, border: 0 }} /></tr>}
      </Tag>
    );
  }
  return (
    <Tag ref={elRef} className={className} style={{ ...style, paddingTop: range.padTop, paddingBottom: range.padBottom }}>
      {slice.map((item, i) => renderItem(item, range.start + i))}
    </Tag>
  );
});

export default VirtualGrid;

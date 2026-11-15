import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import { useT } from '../utils/i18n';
import { menuKeyTarget } from '../utils/menuKeys';

// "More" at the end of the nav bar: the tabs the bar is not showing (unpinned
// in Settings, utils/navTabs moreTabs), so hiding a tab never hides the feature.
//
// A menu button (WAI-ARIA): Enter, Space or ArrowDown opens it on the first
// item, ArrowUp on the last; arrows, Home and End move; Esc or Tab closes it and
// puts focus back on the button; so does picking an item. A click anywhere else
// closes it, as does scrolling or resizing, which would leave it adrift.
//
// The menu is drawn in <body>: the bar scrolls sideways as a last resort and on
// phones is fixed with a backdrop-filter, either of which would clip a popup
// drawn inside it. It opens upward from a bar at the bottom of the screen.
export default function NavMoreMenu({ items, onSelect }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const firstFocus = useRef(0);
  const menuId = `${useId()}-menu`;
  const label = t('nav.more');

  const openAt = (index) => {
    const r = buttonRef.current.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setPos(r.top > window.innerHeight / 2
      ? { right, bottom: window.innerHeight - r.top + 6 }
      : { right, top: r.bottom + 6 });
    firstFocus.current = index;
    setOpen(true);
  };

  const close = (refocus) => {
    setOpen(false);
    if (refocus && buttonRef.current) buttonRef.current.focus({ preventScroll: true });
  };

  // Into the menu as soon as it is in the page.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const entries = menuRef.current.querySelectorAll('[role="menuitem"]');
    const target = entries[Math.min(Math.max(firstFocus.current, 0), entries.length - 1)];
    if (target) target.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onViewport = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport);
    };
  }, [open]);

  const onMenuKeyDown = (e) => {
    const entries = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const target = menuKeyTarget(e.key, entries.indexOf(document.activeElement), entries.length);
    if (target === null) return;
    e.preventDefault();
    if (target === 'close') close(true);
    else entries[target].focus({ preventScroll: true });
  };

  const onButtonKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    openAt(e.key === 'ArrowDown' ? 0 : items.length - 1);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="nav-tab nav-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        <Ellipsis size={18} aria-hidden="true" />
        <span className="nav-tab-label">{label}</span>
      </button>
      {open && pos && createPortal(
        // Keys are handled on the menu, which holds focus while it is open.
        // eslint-disable-next-line jsx-a11y/interactive-supports-focus
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="nav-more-menu" style={pos} onKeyDown={onMenuKeyDown}>
          {items.map(({ tab, label: itemLabel, Icon }) => (
            <button
              key={tab}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="nav-more-item"
              onClick={() => { close(true); onSelect(tab); }}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{itemLabel}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

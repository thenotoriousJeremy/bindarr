import { useEffect, useRef, useState } from 'react';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import { FOCUSABLE_SELECTOR, trapTabTarget, closeDecision, openModals as open } from '../utils/modalBehavior';

// Keyboard handling is window-level so Esc and the Tab trap still work after a
// click on the backdrop moves focus to <body>, and only the topmost dialog of
// a stack reacts.
let listening = false;

const isTabbable = (el) => el.getClientRects().length > 0 && !el.closest('[inert]');

function onKeyDown(e) {
  const top = open[open.length - 1];
  if (!top || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    top.request('escape');
  } else if (e.key === 'Tab') {
    const dialog = top.ref.current;
    if (!dialog) return;
    const items = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isTabbable);
    const target = trapTabTarget(items.length, items.indexOf(document.activeElement), e.shiftKey);
    if (target === null) return;
    e.preventDefault();
    (target === -1 ? dialog : items[target]).focus();
  }
}

// The one dialog shell every modal uses:
// - role="dialog" + aria-modal, labelled by `labelledBy` (heading id) or `label`
// - focus moves in on open ([data-autofocus], an autoFocus child, or the
//   dialog itself), Tab is trapped, and focus returns to the opener on close
// - Esc closes; a backdrop click closes too, but never silently discards
//   edits: `dirty` asks first, `closeOnBackdrop={false}` ignores it outright
// - phone Back closes it, through useBackGuard (`backGuard={false}` when the
//   caller already guards the same state)
//
// `overlayStyle` styles the full-screen backdrop (`.modal-overlay` supplies
// the safe-area padding); `className`/`style` style the dialog panel.
export default function Modal({
  onClose, label, labelledBy, dirty = false, closeOnBackdrop = true, backGuard = true,
  overlayClassName = 'modal-overlay', overlayStyle, className, style, children,
}) {
  const { t } = useT();
  const ref = useRef(null);
  const downOnBackdrop = useRef(false);
  // Captured during the first render: autoFocus children move focus before
  // any effect runs.
  const [opener] = useState(() => (typeof document !== 'undefined' ? document.activeElement : null));

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const request = (source) => {
    const decision = closeDecision({ source, dirty, closeOnBackdrop });
    if (decision === 'ignore') return;
    if (decision === 'confirm' && !window.confirm(t('common.discardChanges'))) return;
    onCloseRef.current && onCloseRef.current();
  };
  const requestRef = useRef(request);
  requestRef.current = request;

  useBackGuard(backGuard, onClose);

  useEffect(() => {
    const entry = { ref, request: (source) => requestRef.current(source) };
    open.push(entry);
    if (!listening) {
      window.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    const dialog = ref.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector('[data-autofocus]');
      (first || dialog).focus({ preventScroll: true });
    }
    return () => {
      const i = open.indexOf(entry);
      if (i !== -1) open.splice(i, 1);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [opener]);

  return (
    // The backdrop click is a mouse shortcut only; keyboard users close with
    // Esc (window listener above), so the backdrop needs no key handler/role.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      className={overlayClassName}
      style={overlayStyle}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        // Clicks never leak to whatever the modal is rendered inside (a card
        // tile, a row) -- the panels used to stop them themselves.
        e.stopPropagation();
        // Both ends on the backdrop: a drag that starts in a text field and
        // ends outside the panel is not a dismissal.
        if (e.target === e.currentTarget && downOnBackdrop.current) request('backdrop');
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        className={className ? `modal-dialog ${className}` : 'modal-dialog'}
        style={style}
      >
        {children}
      </div>
    </div>
  );
}

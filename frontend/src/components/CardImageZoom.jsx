import { X } from 'lucide-react';
import CardImage from './CardImage';
import Modal from './Modal';
import { useT } from '../utils/i18n';

// Full-screen card art viewer, shared by the collection inspector and the
// Search & Add quick-add drawer so "tap the art to enlarge" works the same
// everywhere. Callers own the open/closed flag and render this when open.
//
// Takes the whole card rather than a URL so a card with no art enlarges to its
// card back instead of to a broken image at full screen size.
//
// Clicks stay inside: callers sit inside an overlay whose own click handler
// dismisses the popup, and <Modal> stops them so closing the zoom does not
// dismiss the popup underneath as well.
export default function CardImageZoom({ card, onClose }) {
  const { t } = useT();
  return (
    <Modal
      onClose={onClose}
      label={card?.name}
      style={{ display: 'flex', maxHeight: '88vh', maxWidth: '88vw' }}
      overlayStyle={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        cursor: 'zoom-out',
        padding: 'max(1rem, max(env(safe-area-inset-top, 0px), var(--sat, 0px))) 1rem max(1rem, max(env(safe-area-inset-bottom, 0px), var(--sab, 0px))) 1rem'
      }}
    >
      <button
        className="btn btn-secondary btn-icon-only"
        onClick={onClose}
        aria-label={t('common.close')}
        style={{
          position: 'absolute',
          top: 'max(1rem, max(env(safe-area-inset-top, 0px), var(--sat, 0px)))',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff'
        }}
      >
        <X size={20} />
      </button>
      <CardImage
        card={card}
        style={{
          maxHeight: '88vh',
          maxWidth: '88vw',
          objectFit: 'contain',
          /* No border-radius: the card art already has its own rounded
             corners, so a CSS radius here clips them. drop-shadow follows
             the image's own shape instead of a rounded box. */
          filter: 'drop-shadow(0 20px 60px rgba(0,0,0,0.8))'
        }}
      />
    </Modal>
  );
}

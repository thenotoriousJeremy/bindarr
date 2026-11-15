import { useT } from '../utils/i18n';
import { normalizeToast } from '../utils/toast';

// The toast, drawn the same way over the login screen and over the app
// (App.jsx). The status region stays mounted and only its content changes:
// screen readers often skip a live region that appears together with its text.
export default function Toast({ toast, onDismiss }) {
  const { t } = useT();
  const shown = normalizeToast(toast);
  return (
    <div className="toast-region" role="status">
      {shown && (
        <div key={shown.id ?? shown.message} className={shown.onAction ? 'toast toast-action' : 'toast'}>
          <span>{shown.message}</span>
          {shown.onAction && (
            <button
              type="button"
              className="toast-action-btn"
              onClick={() => { const run = shown.onAction; if (onDismiss) onDismiss(shown.id); run(); }}
            >
              {shown.actionLabel || t('toast.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

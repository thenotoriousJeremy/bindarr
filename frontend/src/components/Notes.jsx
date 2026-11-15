import { useState, useEffect, useMemo, useRef, memo } from 'react';
import { Plus, Pin, Trash2, Search } from 'lucide-react';
import { useT } from '../utils/i18n';
import { createAutosave } from '../utils/noteAutosave';
import { useStableCallback } from '../utils/useStableCallback';

// One text field of one note, as the autosave (utils/noteAutosave) names it.
const fieldKey = (id, field) => `${id}:${field}`;
// keepalive lets a save sent while the page goes away still arrive. Browsers cap
// such a request's body at 64 KiB, so a longer note goes as an ordinary request.
const KEEPALIVE_MAX = 60000;

function NoteItem({ note, onEdit, onCommit, onTogglePin, onDelete }) {
  const { t } = useT();
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');

  useEffect(() => {
    setTitle(note.title || '');
  }, [note.title]);

  useEffect(() => {
    setBody(note.body || '');
  }, [note.body]);

  // Each keystroke goes to the autosave, which saves once the typing pauses;
  // leaving the field saves at once.
  const editTitle = (value) => { setTitle(value); onEdit(note.id, 'title', value, note.title || ''); };
  const editBody = (value) => { setBody(value); onEdit(note.id, 'body', value, note.body || ''); };

  return (
    <div className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          value={title}
          placeholder={t('notes.titlePlaceholder')}
          aria-label={t('notes.titlePlaceholder')}
          onChange={e => editTitle(e.target.value)}
          onBlur={() => onCommit(note.id, 'title', title, note.title || '')}
          style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-strong)', fontWeight: 600, fontSize: '1rem' }}
        />
        <button
          className="btn btn-secondary btn-icon-only"
          title={t(note.pinned ? 'notes.unpin' : 'notes.pin')}
          aria-label={t(note.pinned ? 'notes.unpin' : 'notes.pin')}
          onClick={() => onTogglePin(note)}
          style={{ padding: '0.3rem', color: note.pinned ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}
        >
          <Pin size={14} fill={note.pinned ? 'currentColor' : 'none'} />
        </button>
        <button
          className="btn btn-secondary btn-icon-only"
          title={t('common.delete')}
          aria-label={t('common.delete')}
          onClick={() => onDelete(note.id)}
          style={{ padding: '0.3rem', color: 'var(--accent-red)' }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        value={body}
        placeholder={t('notes.bodyPlaceholder')}
        aria-label={t('notes.bodyPlaceholder')}
        onChange={e => editBody(e.target.value)}
        onBlur={() => onCommit(note.id, 'body', body, note.body || '')}
        rows={5}
        style={{ resize: 'vertical', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)', padding: '0.5rem', fontSize: '0.9rem', fontFamily: 'inherit' }}
      />
    </div>
  );
}

// Standalone scratchpad notebook, separate from card entries. Notes are
// per-user (auth via the global fetch token interceptor). Typing saves a moment
// after it pauses, and at once when the field loses focus, this tab is hidden,
// or the page is closed or backgrounded; pin keeps a note at the top.
function Notes({ showToast, active = true }) {
  const { t } = useT();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');

  // PUT one text field; resolves to whether the server took it.
  const saveText = useStableCallback(async (key, value) => {
    const at = key.indexOf(':');
    const field = key.slice(at + 1);
    const body = JSON.stringify({ [field]: value });
    const r = await fetch(`/api/notes/${key.slice(0, at)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: new TextEncoder().encode(body).length < KEEPALIVE_MAX,
    });
    return r.ok;
  });
  const saveFailed = useStableCallback(() => showToast?.(t('notes.errSave')));
  const saverRef = useRef(null);
  if (!saverRef.current) saverRef.current = createAutosave({ save: saveText, onError: saveFailed });
  const saver = saverRef.current;

  // Typing not saved yet goes out at once when the page is hidden or left (a
  // closed tab, the app sent to the background) and when Notes unmounts (a
  // logout); only on blur, it was lost.
  useEffect(() => {
    const flush = () => { saver.flushAll(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
      saver.dispose();
    };
  }, [saver]);

  // And when another tab is opened: Notes stays mounted, hidden, meanwhile.
  useEffect(() => {
    if (!active) saver.flushAll();
  }, [active, saver]);

  // Loaded once. It used to reload whenever `t` changed (a language switch),
  // which could put an older copy of a note over text still being saved; and a
  // failed load showed an empty notebook instead of saying it failed.
  const loadFailed = useStableCallback(() => showToast?.(t('notes.errLoad')));
  useEffect(() => {
    let cancelled = false;
    fetch('/api/notes')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (cancelled) return;
        const list = Array.isArray(d.notes) ? d.notes : (Array.isArray(d) ? d : []);
        setNotes(list);
      })
      .catch(() => { if (!cancelled) loadFailed(); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadFailed]);

  const createNote = async () => {
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Stored, not just displayed: a note created in German keeps its German
        // placeholder title even if the app language changes later. That is the
        // note's own content from here on.
        body: JSON.stringify({ title: t('notes.untitled'), body: '' }),
      });
      if (!r.ok) {
        showToast?.(t('notes.errCreate'));
        return;
      }
      const d = await r.json();
      if (d.note) setNotes(prev => [d.note, ...prev]);
    } catch {
      showToast?.(t('notes.errCreate'));
    }
  };

  // A keystroke in a title or body: the autosave saves it once the typing pauses.
  const editField = (id, field, value, original) => saver.edit(fieldKey(id, field), value, original);

  // Leaving a field: the list's copy takes the text (search and sort read it),
  // and the autosave sends it now instead of after the pause. Also a retry for a
  // save that failed earlier.
  const commitField = (id, field, value, original) => {
    setNotes(prev => (prev.some(n => n.id === id && (n[field] || '') !== value)
      ? prev.map(n => (n.id === id ? { ...n, [field]: value } : n))
      : prev));
    saver.edit(fieldKey(id, field), value, original);
    saver.flush(fieldKey(id, field));
  };

  // Persist one field (the pin). Bumps updated_at server-side; we re-sort on next load.
  const saveField = async (id, field, value) => {
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, [field]: value } : n)));
    try {
      const r = await fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) showToast?.(t('notes.errSave'));
    } catch {
      showToast?.(t('notes.errSave'));
    }
  };

  const togglePin = (note) => saveField(note.id, 'pinned', note.pinned ? 0 : 1);

  const deleteNote = async (id) => {
    if (!window.confirm(t('notes.confirmDelete'))) return;
    try {
      const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        showToast?.(t('notes.errDelete'));
        return;
      }
      // Typing still waiting to be saved has no note to go to now.
      saver.forget(fieldKey(id, 'title'));
      saver.forget(fieldKey(id, 'body'));
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch {
      showToast?.(t('notes.errDelete'));
    }
  };

  // Search + sort are client-side: the full note set is already loaded and
  // small. Pinned notes always lead, sorted among themselves by the same key.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q))
      : notes;
    const cmp = {
      updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
      created: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    }[sort];
    return [...filtered].sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (cmp ? cmp(a, b) : 0));
  }, [notes, query, sort]);

  if (loading) return <div className="spinner" aria-label={t('common.loading')} style={{ margin: '4rem auto' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.3rem', color: 'var(--text-strong)' }}>{t('nav.notes')}</h2>
        <button className="btn btn-primary" onClick={createNote}>
          <Plus size={16} /> {t('notes.new')}
        </button>
      </div>

      {notes.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
            <Search size={15} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
            <input
              className="input-control"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('notes.searchPlaceholder')}
              aria-label={t('notes.searchPlaceholder')}
              style={{ paddingLeft: '2rem', width: '100%' }}
            />
          </div>
          <select className="select-control" value={sort} onChange={e => setSort(e.target.value)} aria-label={t('collection.sortBy')} style={{ width: 'auto' }}>
            <option value="updated">{t('notes.sortUpdated')}</option>
            <option value="created">{t('notes.sortCreated')}</option>
            <option value="title">{t('notes.sortTitle')}</option>
          </select>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('notes.emptyState')}
        </div>
      ) : visible.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('notes.noMatches', { query })}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
          {visible.map(note => (
            <NoteItem
              key={note.id}
              note={note}
              onEdit={editField}
              onCommit={commitField}
              onTogglePin={togglePin}
              onDelete={deleteNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Memoized: App re-renders on every toast, and its props here are stable.
export default memo(Notes);

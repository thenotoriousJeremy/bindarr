import { useState, useEffect, useMemo } from 'react';
import { Plus, Pin, Trash2, Search } from 'lucide-react';
import { useT } from '../utils/i18n';

function NoteItem({ note, onSave, onTogglePin, onDelete }) {
  const { t } = useT();
  const [title, setTitle] = useState(note.title || '');
  const [body, setBody] = useState(note.body || '');

  useEffect(() => {
    setTitle(note.title || '');
  }, [note.title]);

  useEffect(() => {
    setBody(note.body || '');
  }, [note.body]);

  const handleTitleBlur = () => {
    if (title !== (note.title || '')) {
      onSave(note.id, 'title', title);
    }
  };

  const handleBodyBlur = () => {
    if (body !== (note.body || '')) {
      onSave(note.id, 'body', body);
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          value={title}
          placeholder={t('notes.titlePlaceholder')}
          onChange={e => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-strong)', fontWeight: 600, fontSize: '1rem', outline: 'none' }}
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
        onChange={e => setBody(e.target.value)}
        onBlur={handleBodyBlur}
        rows={5}
        style={{ resize: 'vertical', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)', padding: '0.5rem', fontSize: '0.9rem', outline: 'none', fontFamily: 'inherit' }}
      />
    </div>
  );
}

// Standalone scratchpad notebook, separate from card entries. Notes are
// per-user (auth via the global fetch token interceptor). Editing saves on
// blur; pin keeps a note at the top.
function Notes({ showToast }) {
  const { t } = useT();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');

  useEffect(() => {
    fetch('/api/notes')
      .then(r => (r.ok ? r.json() : { notes: [] }))
      .then(d => {
        const list = Array.isArray(d.notes) ? d.notes : (Array.isArray(d) ? d : []);
        setNotes(list);
      })
      .catch(() => showToast?.(t('notes.errLoad')))
      .finally(() => setLoading(false));
  }, [showToast, t]);

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

  // Persist one field. Bumps updated_at server-side; we re-sort on next load.
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
              style={{ paddingLeft: '2rem', width: '100%' }}
            />
          </div>
          <select className="select-control" value={sort} onChange={e => setSort(e.target.value)} style={{ width: 'auto' }}>
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
              onSave={saveField}
              onTogglePin={togglePin}
              onDelete={deleteNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default Notes;

import { useState, useEffect, useMemo } from 'react';
import { Plus, Pin, Trash2, Search } from 'lucide-react';

// Standalone scratchpad notebook, separate from card entries. Notes are
// per-user (auth via the global fetch token interceptor). Editing saves on
// blur; pin keeps a note at the top.
function Notes({ showToast }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');

  useEffect(() => {
    fetch('/api/notes')
      .then(r => r.json())
      .then(d => setNotes(d.notes || []))
      .catch(() => showToast('Failed to load notes'))
      .finally(() => setLoading(false));
  }, [showToast]);

  const createNote = async () => {
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled', body: '' }),
      });
      const d = await r.json();
      if (d.note) setNotes(prev => [d.note, ...prev]);
    } catch {
      showToast('Failed to create note');
    }
  };

  // Persist one field. Bumps updated_at server-side; we re-sort on next load.
  const saveField = async (id, field, value) => {
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, [field]: value } : n)));
    try {
      await fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
    } catch {
      showToast('Failed to save note');
    }
  };

  const togglePin = (note) => saveField(note.id, 'pinned', note.pinned ? 0 : 1);

  const deleteNote = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    try {
      await fetch(`/api/notes/${id}`, { method: 'DELETE' });
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch {
      showToast('Failed to delete note');
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading" style={{ margin: '4rem auto' }} />;

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
    return [...filtered].sort((a, b) => (b.pinned - a.pinned) || cmp(a, b));
  }, [notes, query, sort]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.3rem', color: 'var(--text-strong)' }}>Notes</h2>
        <button className="btn btn-primary" onClick={createNote}>
          <Plus size={16} /> New Note
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
              placeholder="Search notes..."
              style={{ paddingLeft: '2rem', width: '100%' }}
            />
          </div>
          <select className="select-control" value={sort} onChange={e => setSort(e.target.value)} style={{ width: 'auto' }}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="title">Title (A-Z)</option>
          </select>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No notes yet. Create one to jot down wishlist ideas, deals, or trade plans.
        </div>
      ) : visible.length === 0 ? (
        <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No notes match "{query}".
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
          {visible.map(note => (
            <div key={note.id} className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  defaultValue={note.title}
                  placeholder="Title"
                  onBlur={e => e.target.value !== note.title && saveField(note.id, 'title', e.target.value)}
                  style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-strong)', fontWeight: 600, fontSize: '1rem', outline: 'none' }}
                />
                <button
                  className="btn btn-secondary btn-icon-only"
                  title={note.pinned ? 'Unpin' : 'Pin'}
                  aria-label={note.pinned ? 'Unpin' : 'Pin'}
                  onClick={() => togglePin(note)}
                  style={{ padding: '0.3rem', color: note.pinned ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}
                >
                  <Pin size={14} fill={note.pinned ? 'currentColor' : 'none'} />
                </button>
                <button
                  className="btn btn-secondary btn-icon-only"
                  title="Delete"
                  aria-label="Delete"
                  onClick={() => deleteNote(note.id)}
                  style={{ padding: '0.3rem', color: 'var(--accent-red)' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                defaultValue={note.body}
                placeholder="Write something..."
                onBlur={e => e.target.value !== note.body && saveField(note.id, 'body', e.target.value)}
                rows={5}
                style={{ resize: 'vertical', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)', padding: '0.5rem', fontSize: '0.9rem', outline: 'none', fontFamily: 'inherit' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Notes;

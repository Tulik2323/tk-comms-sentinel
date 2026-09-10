// Modal — חלון popup מרכזי
import { useEffect } from 'react';

export default function Modal({ open, onClose, title, children, width = 500 }) {
  // סגירה עם ESC
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position:   'fixed',
        inset:      0,
        background: 'rgba(0,0,0,0.7)',
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex:     1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background:   'var(--bg-card)',
          border:       '1px solid var(--border)',
          borderRadius: 12,
          width:        '100%',
          maxWidth:     width,
          maxHeight:    '90vh',
          overflowY:    'auto',
          padding:      24,
          direction:    'rtl',
        }}
      >
        {title && (
          <div style={{
            display:        'flex',
            justifyContent: 'space-between',
            alignItems:     'center',
            marginBottom:   16,
          }}>
            <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text-primary)' }}>
              {title}
            </h2>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border:     'none',
                cursor:     'pointer',
                fontSize:   20,
                color:      'var(--text-muted)',
                lineHeight: 1,
              }}
            >×</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

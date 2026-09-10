// Badge — תגית צבעונית קטנה
export default function Badge({ children, color = 'blue', className = '' }) {
  const variants = {
    green:  { background: '#166534', color: '#bbf7d0' },
    red:    { background: '#7f1d1d', color: '#fecaca' },
    orange: { background: '#7c2d12', color: '#fed7aa' },
    blue:   { background: '#1e3a8a', color: '#bfdbfe' },
    gray:   { background: '#374151', color: '#d1d5db' },
  };

  const style = variants[color] || variants.gray;

  return (
    <span
      className={`nm-badge ${className}`}
      style={{ background: style.background, color: style.color }}
    >
      {children}
    </span>
  );
}

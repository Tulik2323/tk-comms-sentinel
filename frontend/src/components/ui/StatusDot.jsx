// StatusDot — עיגול ירוק/אדום/כתום שמציג סטטוס מכשיר
export default function StatusDot({ status, size = 10, pulse = false }) {
  const colors = {
    up:      'var(--status-up)',
    down:    'var(--status-down)',
    warn:    'var(--status-warn)',
    unknown: 'var(--status-unknown)',
  };

  const color = colors[status] || colors.unknown;

  return (
    <span
      style={{
        display:      'inline-block',
        width:        size,
        height:       size,
        borderRadius: '50%',
        background:   color,
        flexShrink:   0,
        position:     'relative',
        boxShadow:    `0 0 ${size / 2}px ${color}66`,
      }}
      title={status}
    >
      {pulse && status === 'down' && (
        <span style={{
          position:   'absolute',
          inset:      0,
          borderRadius:'50%',
          background: color,
          animation:  'pulse-ring 1.5s ease-out infinite',
          opacity:    0.5,
        }} />
      )}
    </span>
  );
}

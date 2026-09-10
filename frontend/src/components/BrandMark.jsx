// BrandMark — הסמל של TK Comms Sentinel כוקטור
//
// מגן + מונוגרמת TK בסגנון מסלולי מעגל + טבעות שבורות + עין.
// וקטור ולא PNG: חד בכל גודל, מתאים את עצמו לתמה, ונטען מיידית.
//
// props:
//   size      — גודל בפיקסלים (ריבועי)
//   animated  — טבעות מסתובבות ופעימה על המסלולים
//   idPrefix  — מרחב שמות ל-gradients, למניעת התנגשות בין מופעים בדף

export default function BrandMark({ size = 96, animated = false, idPrefix = 'bm', ...rest }) {
  const g    = `${idPrefix}-grad`;
  const g2   = `${idPrefix}-shield`;
  const glow = `${idPrefix}-glow`;

  return (
    <svg
      viewBox="0 0 240 240"
      width={size}
      height={size}
      fill="none"
      role="img"
      aria-label="TK Comms Sentinel"
      className={animated ? 'tk-mark tk-mark-live' : 'tk-mark'}
      {...rest}
    >
      <defs>
        {/* כחול → ירוק: אות שעוברת מקצה לקצה */}
        <linearGradient id={g} x1="40" y1="40" x2="200" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0"    stopColor="#4FC3F7" />
          <stop offset="0.52" stopColor="#6FD68A" />
          <stop offset="1"    stopColor="#A5E063" />
        </linearGradient>

        {/* מתכת קרה למגן */}
        <linearGradient id={g2} x1="70" y1="50" x2="170" y2="176" gradientUnits="userSpaceOnUse">
          <stop offset="0"    stopColor="#E8EEF5" stopOpacity="0.95" />
          <stop offset="0.45" stopColor="#8FA3B8" stopOpacity="0.55" />
          <stop offset="1"    stopColor="#5A6B80" stopOpacity="0.75" />
        </linearGradient>

        <filter id={glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ---- טבעות מעגל שבורות ---- */}
      <g stroke={`url(#${g})`} fill="none" strokeLinecap="round">
        <circle className="tk-ring tk-ring-1" cx="120" cy="118" r="112"
                strokeWidth="1.6" opacity="0.30"
                strokeDasharray="34 26 118 30 62 46" />
        <circle className="tk-ring tk-ring-2" cx="120" cy="118" r="100"
                strokeWidth="1.9" opacity="0.55"
                strokeDasharray="70 24 96 34 58 42" />
        <circle className="tk-ring tk-ring-3" cx="120" cy="118" r="88"
                strokeWidth="1.4" opacity="0.38"
                strokeDasharray="46 30 130 28 54 34" />
      </g>

      {/* צמתים על הטבעות */}
      <g fill={`url(#${g})`}>
        <circle cx="120" cy="18"  r="3.4" />
        <circle cx="208" cy="150" r="3"   opacity="0.85" />
        <circle cx="32"  cy="150" r="3"   opacity="0.85" />
        <circle cx="20"  cy="118" r="2.6" opacity="0.7" />
        <circle cx="220" cy="118" r="2.6" opacity="0.7" />
        <circle cx="120" cy="30"  r="2.2" opacity="0.6" />
      </g>

      {/* ---- מגן ---- */}
      <path
        d="M120 50 L170 68 L170 116 C170 146 148 163 120 174 C92 163 70 146 70 116 L70 68 Z"
        fill={`url(#${g2})`}
        stroke={`url(#${g2})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M120 60 L161 74 L161 115 C161 139 143 153 120 163 C97 153 79 139 79 115 L79 74 Z"
        fill="#0B1B2E"
        fillOpacity="0.72"
        stroke={`url(#${g})`}
        strokeWidth="1.1"
        strokeOpacity="0.45"
        strokeLinejoin="round"
      />

      {/* ---- מונוגרמת TK כמסלולי מעגל ---- */}
      <g
        stroke={`url(#${g})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        filter={`url(#${glow})`}
      >
        {/* T */}
        <path className="tk-trace" d="M86 92 H118" />
        <path className="tk-trace" d="M102 92 V142" />
        {/* הסתעפות — נותנת את אופי המעגל המודפס */}
        <path className="tk-trace" d="M102 112 H91 V125" strokeWidth="2" opacity="0.8" />

        {/* אפיק מקשר בין שתי האותיות */}
        <path className="tk-trace" d="M102 118 H126" strokeWidth="1.8" opacity="0.55" />

        {/* K */}
        <path className="tk-trace" d="M126 92 V142" />
        <path className="tk-trace" d="M126 117 L148 95" />
        <path className="tk-trace" d="M126 117 L150 142" />
        <path className="tk-trace" d="M138 105 H149 V96" strokeWidth="2" opacity="0.8" />
      </g>

      {/* צמתי חיבור על המונוגרמה */}
      <g fill={`url(#${g})`}>
        <circle cx="86"  cy="92"  r="3" />
        <circle cx="118" cy="92"  r="3" />
        <circle cx="102" cy="142" r="3" />
        <circle cx="91"  cy="125" r="2.4" opacity="0.85" />
        <circle cx="126" cy="92"  r="3" />
        <circle cx="148" cy="95"  r="3" />
        <circle cx="150" cy="142" r="3" />
        <circle cx="126" cy="142" r="2.4" opacity="0.85" />
        <circle cx="114" cy="118" r="2"  opacity="0.7" />
      </g>

      {/* ---- עין: הצפייה המתמדת ---- */}
      <g>
        <path
          d="M90 199 Q120 179 150 199 Q120 219 90 199 Z"
          fill="#0B1B2E"
          fillOpacity="0.85"
          stroke={`url(#${g})`}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <circle className="tk-pupil" cx="120" cy="199" r="8.5" fill={`url(#${g})`} />
        <circle cx="123" cy="196" r="2.8" fill="#0B1B2E" fillOpacity="0.75" />
      </g>

      {/* קווי חיבור מהעין לטבעות */}
      <g stroke={`url(#${g})`} strokeWidth="1.4" opacity="0.5" strokeLinecap="round">
        <path d="M90 199 H62 L48 185" />
        <path d="M150 199 H178 L192 185" />
      </g>
    </svg>
  );
}

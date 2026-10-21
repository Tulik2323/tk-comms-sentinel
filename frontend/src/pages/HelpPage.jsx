// HelpPage — דף העזרה. אין לו תוכן משלו: הוא מציג את backend/help/guide.md.
// רינדור Markdown פשוט בלי ספרייה חיצונית: כותרות, פסקאות, רשימות, טבלאות,
// הדגשה וקוד. בונה אלמנטים של React (לא HTML גולמי), כך שאין הזרקת קוד.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

// **מודגש** ו-`קוד` בתוך שורה
function inline(text, keyBase) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-${i++}`} dir="ltr" style={codeStyle}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const codeStyle = {
  fontFamily: 'monospace', fontSize: '0.92em', padding: '1px 5px', borderRadius: 4,
  background: 'var(--bg-hover)', unicodeBidi: 'isolate',
};

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

// מפרק את הטקסט לבלוקים: {type, ...}
function parse(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }

    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      blocks.push({ type: 'ol', items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

const slug = (text, idx) => `help-${idx}`;

export default function HelpPage() {
  const { t } = useTranslation();
  const [markdown, setMarkdown] = useState(null);
  const [error,    setError]    = useState(false);

  useEffect(() => {
    api.get('/help')
      .then(r => { if (r.data?.ok) setMarkdown(r.data.markdown); else setError(true); })
      .catch(() => setError(true));
  }, []);

  if (error) {
    return <div style={{ padding: 32, color: 'var(--text-muted)' }}>{t('help_unavailable')}</div>;
  }
  if (markdown === null) {
    return <div style={{ padding: 32, color: 'var(--text-muted)' }}>{t('loading')}</div>;
  }

  const blocks = parse(markdown);
  const toc = blocks.map((b, idx) => ({ ...b, idx })).filter(b => b.type === 'h' && b.level === 2);

  const th = { padding: '8px 12px', textAlign: 'start', fontWeight: 600, fontSize: 13,
               borderBottom: '2px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' };
  const td = { padding: '8px 12px', fontSize: 14, borderBottom: '1px solid var(--border)', verticalAlign: 'top' };

  return (
    <div dir="rtl" style={{ padding: '24px 28px', maxWidth: 960, margin: '0 auto', color: 'var(--text-primary)', lineHeight: 1.7 }}>
      {toc.length > 1 && (
        <nav className="nm-card" style={{ padding: '12px 16px', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>{t('help_contents')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {toc.map(h => (
              <button key={h.idx} type="button"
                onClick={() => document.getElementById(slug(h.text, h.idx))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                         color: 'var(--accent)', fontSize: 14 }}>
                {h.text}
              </button>
            ))}
          </div>
        </nav>
      )}

      {blocks.map((b, idx) => {
        const k = `b${idx}`;
        if (b.type === 'h') {
          if (b.level === 1) return <h1 key={k} style={{ fontSize: 24, margin: '0 0 16px' }}>{inline(b.text, k)}</h1>;
          if (b.level === 2) return (
            <h2 key={k} id={slug(b.text, idx)}
                style={{ fontSize: 19, margin: '32px 0 12px', paddingBottom: 6, borderBottom: '1px solid var(--border)', scrollMarginTop: 16 }}>
              {inline(b.text, k)}
            </h2>
          );
          return <h3 key={k} style={{ fontSize: 16, margin: '22px 0 8px' }}>{inline(b.text, k)}</h3>;
        }
        if (b.type === 'p')  return <p key={k} style={{ margin: '0 0 12px', fontSize: 14 }}>{inline(b.text, k)}</p>;
        if (b.type === 'ul') return (
          <ul key={k} style={{ margin: '0 0 12px', paddingInlineStart: 22, fontSize: 14, listStyleType: 'disc' }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{inline(it, `${k}-${j}`)}</li>)}
          </ul>
        );
        if (b.type === 'ol') return (
          <ol key={k} style={{ margin: '0 0 12px', paddingInlineStart: 22, fontSize: 14, listStyleType: 'decimal' }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{inline(it, `${k}-${j}`)}</li>)}
          </ol>
        );
        if (b.type === 'table') return (
          <div key={k} style={{ overflowX: 'auto', margin: '0 0 16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{b.head.map((c, j) => <th key={j} style={th}>{inline(c, `${k}-h${j}`)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, j) => <td key={j} style={td}>{inline(c, `${k}-${ri}-${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        return null;
      })}
    </div>
  );
}

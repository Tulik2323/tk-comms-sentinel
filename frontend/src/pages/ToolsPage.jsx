// ToolsPage — אבחון תקשורת מהשרת אל יעד נתון.
// נועד לענות על השאלה "למה המכשיר הזה לא נקלט" בלי לצאת ל-CLI.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

const DEFAULT_PORTS = '22,23,80,443';

function Row({ label, ok, ms, children, muted }) {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '150px 84px 1fr',
      gap: 10, alignItems: 'baseline',
      padding: '8px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{label}</div>
      <div style={{
        fontWeight: 700, fontSize: 13,
        color: muted ? 'var(--text-muted)' : ok ? 'var(--status-up)' : 'var(--status-down)',
      }}>
        {muted ? '—' : ok ? `✅ ${t('ok_label')}` : `❌ ${t('failed_label')}`}
        {ms != null && !muted && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginInlineStart: 6 }}>
            {ms}ms
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{children}</div>
    </div>
  );
}

export default function ToolsPage() {
  const { t }                         = useTranslation();
  const [target,      setTarget]      = useState('');
  const [ports,       setPorts]       = useState(DEFAULT_PORTS);
  const [community,   setCommunity]   = useState('');
  const [snmpVersion, setSnmpVersion] = useState('v2c');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [result,      setResult]      = useState(null);

  async function run(e) {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const res = await api.post('/tools/diagnose', {
        target: target.trim(),
        ports: ports.split(',').map(p => p.trim()).filter(Boolean),
        community: community.trim() || undefined,
        snmpVersion,
      });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || t('diag_error'));
    } finally {
      setLoading(false);
    }
  }

  const verdictColor = {
    ok:    { bg: 'rgba(22,101,52,0.25)',  border: '#16a34a', fg: '#bbf7d0' },
    warn:  { bg: 'rgba(120,53,15,0.28)',  border: '#c2610c', fg: '#fcd9a8' },
    error: { bg: 'rgba(127,29,29,0.25)',  border: '#b91c1c', fg: '#fecaca' },
  };

  return (
    <div>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>🧰 {t('tools_title')}</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 20px' }}>
        {t('tools_subtitle')}
      </p>

      <div className="nm-card" style={{ marginBottom: 16 }}>
        <form onSubmit={run}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                {t('ip_or_host')}
              </label>
              <input className="nm-input" value={target} required
                onChange={e => setTarget(e.target.value)}
                placeholder="10.221.0.2" style={{ fontFamily: 'monospace' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                {t('tcp_ports')}
              </label>
              <input className="nm-input" value={ports}
                onChange={e => setPorts(e.target.value)}
                placeholder={DEFAULT_PORTS} style={{ fontFamily: 'monospace' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                SNMP Community
              </label>
              <input className="nm-input" value={community}
                onChange={e => setCommunity(e.target.value)}
                placeholder={t('community_default_ph')} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                {t('snmp_version_label')}
              </label>
              <select className="nm-input" value={snmpVersion}
                onChange={e => setSnmpVersion(e.target.value)}>
                <option value="v2c">v2c</option>
                <option value="v1">v1</option>
              </select>
            </div>
          </div>

          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}
            style={{ marginTop: 16, padding: '9px 22px' }}>
            {loading ? t('checking_btn') : `▶ ${t('run_diag')}`}
          </button>
        </form>
      </div>

      {error && (
        <div style={{ background: 'rgba(127,29,29,0.28)', border: '1px solid #b91c1c',
                      color: '#fecaca', padding: '10px 14px', borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {result && (
        <div className="nm-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, margin: 0, fontFamily: 'monospace' }}>{result.target}</h2>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{result.totalMs}ms</span>
          </div>

          <div style={{
            padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13,
            border: '1px solid',
            background:  verdictColor[result.verdict.level].bg,
            borderColor: verdictColor[result.verdict.level].border,
            color:       verdictColor[result.verdict.level].fg,
          }}>
            {result.verdict.text}
          </div>

          <Row label={t('dns_resolution')} ok={result.dns.ok} ms={result.dns.skipped ? null : result.dns.ms}
               muted={result.dns.skipped}>
            {result.dns.skipped
              ? t('dns_ip_given')
              : result.dns.ok
                ? result.dns.addresses.join(', ')
                : `${t('fail_prefix')}: ${result.dns.detail}`}
          </Row>

          <Row label="ICMP (ping)" ok={result.icmp.ok} ms={result.icmp.avgMs ?? result.icmp.ms}>
            {result.icmp.ok
              ? `${t('loss_label')} ${result.icmp.loss}%${result.icmp.avgMs != null ? ` · ${t('avg_label')} ${result.icmp.avgMs}ms` : ''}`
              : result.icmp.detail}
          </Row>

          {result.tcp.map(tcp => (
            <Row key={tcp.port} label={`TCP ${tcp.port}${tcp.port === 22 ? ' (SSH)' : tcp.port === 443 ? ' (HTTPS)' : tcp.port === 80 ? ' (HTTP)' : tcp.port === 23 ? ' (Telnet)' : ''}`}
                 ok={tcp.ok && !tcp.intercepted} ms={tcp.ms} muted={tcp.intercepted}>
              {tcp.intercepted
                ? <span style={{ color: 'var(--status-warn)' }}>
                    {t('port_unreliable')}
                  </span>
                : tcp.ok
                  ? (tcp.banner
                      ? <span style={{ fontFamily: 'monospace', fontSize: 12, direction: 'ltr', display: 'inline-block' }}>{tcp.banner}</span>
                      : t('port_open'))
                  : (tcp.detail === 'timeout' ? t('port_no_response') : `${t('port_closed')} (${tcp.detail})`)}
            </Row>
          ))}

          {result.interceptedPorts?.length > 0 && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12,
              background: 'rgba(120,53,15,0.22)', border: '1px solid #c2610c', color: '#fcd9a8',
            }}>
              ⚠ {t('intercept_warning', { ports: result.interceptedPorts.join(', ') })}
            </div>
          )}

          <Row label={`SNMP 161 · ${result.snmp.version}`} ok={result.snmp.ok} ms={result.snmp.ms}>
            {result.snmp.ok ? (
              <div>
                <div><b>{result.snmp.sysName}</b></div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {result.snmp.sysDescr}
                </div>
                {result.snmp.uptimeSec != null && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Uptime: {Math.floor(result.snmp.uptimeSec / 86400)} {t('days_suffix')}
                  </div>
                )}
              </div>
            ) : (
              `${result.snmp.detail || t('snmp_no_response')} — community: ${result.snmp.community}`
            )}
          </Row>
        </div>
      )}
    </div>
  );
}

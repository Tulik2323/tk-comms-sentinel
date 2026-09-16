// TopologyPage — תרשים טופולוגיה עם vis-network
// קווים אדומים/כתומים/ירוקים לפי bandwidth, צמתים מהבהבים כש-DOWN
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Network, DataSet } from 'vis-network/standalone';
import { useTopology } from '../hooks/useTopology';
import { formatBps } from '../lib/api';

export default function TopologyPage() {
  const { t }        = useTranslation();
  const containerRef = useRef(null);
  const networkRef   = useRef(null);
  const navigate     = useNavigate();
  const [showStubs, setShowStubs] = useState(false);
  const { graph, loading, refetch } = useTopology(60, { includeStubs: showStubs });
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const nodes = new DataSet(graph.nodes);
    const edges = new DataSet(graph.edges);

    const options = {
      nodes: {
        shape:       'box',
        borderWidth: 2,
        borderWidthSelected: 3,
        font:        { size: 12, color: '#ffffff', face: 'system-ui' },
        margin:      8,
        shadow:      { enabled: true, color: 'rgba(0,0,0,0.4)', size: 8 },
      },
      edges: {
        arrows:  { to: { enabled: false } },
        smooth:  { type: 'curvedCW', roundness: 0.1 },
        font:    { size: 10, color: '#94a3b8', background: 'rgba(30,41,59,0.8)', strokeWidth: 0 },
        scaling: { min: 1, max: 6 },
      },
      physics: {
        enabled:       true,
        stabilization: { iterations: 150 },
        barnesHut: {
          gravitationalConstant: -8000,
          springLength:           200,
          springConstant:         0.04,
        },
      },
      interaction: {
        hover:            true,
        tooltipDelay:     100,
        navigationButtons: false,
        keyboard:         true,
        zoomView:         true,
      },
      layout: {
        improvedLayout: true,
      },
    };

    // הרס network ישן אם קיים
    if (networkRef.current) {
      networkRef.current.destroy();
    }

    const network = new Network(containerRef.current, { nodes, edges }, options);
    networkRef.current = network;

    // לחיצה על node — navigate לדף המכשיר
    network.on('doubleClick', (params) => {
      if (params.nodes.length > 0) {
        navigate(`/devices/${params.nodes[0]}`);
      }
    });

    // hover — הצג פרטים
    network.on('selectNode', (params) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node   = graph.nodes.find(n => n.id === nodeId);
        setSelected(node);
      }
    });

    network.on('deselectNode', () => setSelected(null));

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [graph, navigate]);

  return (
    <div style={{ padding: 24, height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🕸️ {t('topology_title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
            {[
              { color: '#22c55e', label: '< 60%' },
              { color: '#f97316', label: '60-80%' },
              { color: '#ef4444', label: '> 80%' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 20, height: 4, background: l.color, borderRadius: 2 }} />
                <span style={{ color: 'var(--text-muted)' }}>{l.label}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowStubs(v => !v)}
            className={`nm-btn ${showStubs ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
            title={t('toggle_stubs_title')}
          >
            🖥 {showStubs ? t('hide_edges') : t('show_edges')}
          </button>
          <button onClick={refetch} className="nm-btn nm-btn-ghost">↺ {t('refresh')}</button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 16 }}>
        {/* Graph */}
        <div style={{
          flex:         1,
          background:   'var(--bg-card)',
          borderRadius: 12,
          border:       '1px solid var(--border)',
          overflow:     'hidden',
          position:     'relative',
        }}>
          {loading && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', fontSize: 14, background: 'var(--bg-card)',
              zIndex: 10,
            }}>
              {t('loading_topology')}
            </div>
          )}
          {graph.nodes.length === 0 && !loading && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', textAlign: 'center', padding: 32,
            }}>
              <div>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🕸️</div>
                <div>{t('no_topology_data')}</div>
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  {t('topology_hint')}
                </div>
              </div>
            </div>
          )}
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        {/* Node detail panel */}
        {selected && (
          <div style={{
            width:        260,
            background:   'var(--bg-card)',
            border:       '1px solid var(--border)',
            borderRadius: 12,
            padding:      16,
            flexShrink:   0,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>
              🖧 {selected.label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selected.title?.split('\n').map((l, i) => (
                <div key={i} style={{ marginBottom: 4 }}>{l}</div>
              ))}
            </div>
            <div style={{ margin: '12px 0', borderTop: '1px solid var(--border)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <StatRow label={t('status')} value={
                <span style={{ color: selected.status === 'up' ? '#22c55e' : '#ef4444' }}>
                  {selected.status === 'up' ? `✅ ${t('filter_up')}` : `❌ ${t('filter_down')}`}
                </span>
              } />
              <StatRow label={t('load_label')} value={`${selected.util || 0}%`} />
              <StatRow label={`${t('col_traffic')} ↓`} value={formatBps(selected.in_bps)} />
              <StatRow label={`${t('col_traffic')} ↑`} value={formatBps(selected.out_bps)} />
              {selected.cpu_pct > 0 && <StatRow label="CPU" value={`${Math.round(selected.cpu_pct)}%`} />}
              {selected.isConcentrator && (
                <StatRow label={t('role_label')} value={
                  <span style={{ color: '#facc15' }}>⭐ {t('hub_role', { n: selected.connCount })}</span>
                } />
              )}
            </div>
            <button
              onClick={() => navigate(`/devices/${selected.id}`)}
              className="nm-btn nm-btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}
            >
              {t('full_details')}
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
        {t('topology_footer', { nodes: graph.nodes.length, edges: graph.edges.length })}
      </div>
    </div>
  );
}

function StatRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

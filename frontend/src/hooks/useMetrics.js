// hooks/useMetrics.js — טעינת metrics היסטוריות של מכשיר
import { useState, useEffect } from 'react';
import api from '../lib/api';

export function useMetrics(deviceId, hours = 24) {
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (!deviceId) return;
    setLoading(true);

    Promise.all([
      api.get(`/devices/${deviceId}/metrics?hours=${hours}`),
      api.get(`/devices/${deviceId}/metrics/summary`),
    ]).then(([mRes, sRes]) => {
      setMetrics(mRes.data);
      setSummary(sRes.data);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [deviceId, hours]);

  return { metrics, summary, loading };
}

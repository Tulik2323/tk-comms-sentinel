// hooks/useTopology.js — טעינת גרף טופולוגיה
import { useState, useEffect, useCallback } from 'react';
import api from '../lib/api';

export function useTopology(autoRefreshSec = 60, { includeStubs = false } = {}) {
  const [graph,   setGraph]   = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const res = await api.get('/topology', { params: { stubs: includeStubs ? '1' : undefined } });
      setGraph(res.data);
    } catch (err) {
      console.error('שגיאה בטעינת טופולוגיה:', err);
    } finally {
      setLoading(false);
    }
  }, [includeStubs]);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, autoRefreshSec * 1000);
    return () => clearInterval(interval);
  }, [fetch, autoRefreshSec]);

  return { graph, loading, refetch: fetch };
}

// בונה מחדש את נוסח ההתראה מהשדות המובנים של alert_events, כדי שההודעה
// תוצג בשפה הנבחרת. שורות ישנות שנשמרו לפני שהשדות היו מלאים נופלות
// חזרה ל-message העברי שנשמר ב-DB.
export function formatAlert(a, t) {
  const device = a.device_name || a.device_ip || '';
  const value  = Math.round(a.value);

  if (a.metric === 'status') {
    return t('alert_device_down', { device });
  }

  if (a.metric === 'port_bandwidth_in' || a.metric === 'port_bandwidth_out') {
    if (a.port_if_index == null) return a.message || '';
    return t('alert_port_bw', {
      device,
      port:      a.port_label || `Port ${a.port_if_index}`,
      ifIndex:   a.port_if_index,
      metric:    t(`metric_${a.metric}`),
      value,
      threshold: a.threshold,
    });
  }

  if (['bandwidth_in', 'bandwidth_out', 'cpu', 'mem'].includes(a.metric)) {
    return t('alert_device_metric', {
      device,
      metric:    t(`metric_${a.metric}`),
      value,
      threshold: a.threshold,
    });
  }

  return a.message || '';
}

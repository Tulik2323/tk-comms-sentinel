// ProtectedRoute — מגן על routes שדורשים התחברות
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height:     '100vh',
        background: 'var(--bg-primary)',
        color:      'var(--text-muted)',
      }}>
        טוען...
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/" replace />;

  return children;
}

// App.jsx — Router הראשי של האפליקציה
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import Layout          from './components/Layout';
import ProtectedRoute  from './components/ProtectedRoute';

import LoginPage       from './pages/LoginPage';
import DashboardPage   from './pages/DashboardPage';
import DevicesPage     from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import TopologyPage    from './pages/TopologyPage';
import MapPage         from './pages/MapPage';
import AlertsPage      from './pages/AlertsPage';
import AdminPage       from './pages/AdminPage';
import AuditPage       from './pages/AuditPage';
import ToolsPage       from './pages/ToolsPage';
import ReportsPage       from './pages/ReportsPage';
import PortChangesPage  from './pages/PortChangesPage';
import TrendsPage       from './pages/TrendsPage';
import LicensePage     from './pages/LicensePage';
import WatchdogPage    from './pages/WatchdogPage';
import InventoryPage   from './pages/InventoryPage';

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route path="/" element={
        <ProtectedRoute>
          <Layout>
            <DashboardPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/devices" element={
        <ProtectedRoute>
          <Layout>
            <DevicesPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/devices/:id" element={
        <ProtectedRoute>
          <Layout>
            <DeviceDetailPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/topology" element={
        <ProtectedRoute>
          <Layout>
            <TopologyPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/map" element={
        <ProtectedRoute>
          <Layout>
            <MapPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/alerts" element={
        <ProtectedRoute>
          <Layout>
            <AlertsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin" element={
        <ProtectedRoute adminOnly>
          <Layout>
            <AdminPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/audit" element={
        <ProtectedRoute>
          <Layout>
            <AuditPage />
          </Layout>
        </ProtectedRoute>
      } />

      {/* אבחון מריץ בדיקות רשת מהשרת — adminOnly, כמו נקודת הקצה בצד השרת */}
      <Route path="/tools" element={
        <ProtectedRoute adminOnly>
          <Layout>
            <ToolsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/reports" element={
        <ProtectedRoute adminOnly>
          <Layout>
            <ReportsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/port-changes" element={
        <ProtectedRoute>
          <Layout>
            <PortChangesPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/watchdog" element={
        <ProtectedRoute>
          <Layout>
            <WatchdogPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/trends" element={
        <ProtectedRoute>
          <Layout>
            <TrendsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/inventory" element={
        <ProtectedRoute>
          <Layout>
            <InventoryPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/license" element={
        <ProtectedRoute adminOnly>
          <Layout>
            <LicensePage />
          </Layout>
        </ProtectedRoute>
      } />

      {/* כל שאר הנתיבים → homepage */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

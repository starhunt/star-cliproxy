import { Routes, Route, NavLink } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import ModelMappingsPage from './pages/ModelMappingsPage';
import ApiKeysPage from './pages/ApiKeysPage';
import LogsPage from './pages/LogsPage';
import ApiGuidePage from './pages/ApiGuidePage';
import RateLimitsPage from './pages/RateLimitsPage';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '~' },
  { to: '/models', label: 'Models', icon: '#' },
  { to: '/keys', label: 'API Keys', icon: '*' },
  { to: '/rate-limits', label: 'Rate Limits', icon: '%' },
  { to: '/logs', label: 'Logs', icon: '>' },
  { to: '/guide', label: 'API Guide', icon: '?' },
];

export default function App() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-lg font-bold text-blue-400">star-cliproxy</h1>
          <p className="text-xs text-gray-500 mt-1">AI CLI Proxy Dashboard</p>
        </div>
        <div className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-500/10 text-blue-400'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`
              }
            >
              <span className="font-mono text-xs w-4 text-center">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="p-4 border-t border-gray-800 text-xs text-gray-600">
          v1.0.0 | Port 8300
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-gray-950 p-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/models" element={<ModelMappingsPage />} />
          <Route path="/keys" element={<ApiKeysPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/rate-limits" element={<RateLimitsPage />} />
          <Route path="/guide" element={<ApiGuidePage />} />
        </Routes>
      </main>
    </div>
  );
}

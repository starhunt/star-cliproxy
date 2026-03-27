import { Routes, Route, NavLink } from 'react-router-dom';
import { useTranslation } from './i18n/context';
import { useTheme } from './theme/context';
import DashboardPage from './pages/DashboardPage';
import ModelMappingsPage from './pages/ModelMappingsPage';
import ApiKeysPage from './pages/ApiKeysPage';
import LogsPage from './pages/LogsPage';
import ApiGuidePage from './pages/ApiGuidePage';
import RateLimitsPage from './pages/RateLimitsPage';
import DebugPage from './pages/DebugPage';
import SettingsPage from './pages/SettingsPage';
import ProvidersPage from './pages/ProvidersPage';
import PlaygroundPage from './pages/PlaygroundPage';

// 번역 키 기반 네비게이션
const navItems = [
  { to: '/', labelKey: 'nav.dashboard', icon: '~' },
  { to: '/playground', labelKey: 'nav.playground', icon: '^' },
  { to: '/models', labelKey: 'nav.models', icon: '#' },
  { to: '/keys', labelKey: 'nav.apiKeys', icon: '*' },
  { to: '/rate-limits', labelKey: 'nav.rateLimits', icon: '%' },
  { to: '/providers', labelKey: 'nav.providers', icon: '&' },
  { to: '/logs', labelKey: 'nav.logs', icon: '>' },
  { to: '/debug', labelKey: 'nav.debug', icon: '!' },
  { to: '/settings', labelKey: 'nav.settings', icon: '@' },
  { to: '/guide', labelKey: 'nav.apiGuide', icon: '?' },
];

export default function App() {
  const { t, lang, setLang } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-screen">
      {/* 사이드바 */}
      <nav className="w-56 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <h1 className="text-lg font-bold text-blue-600 dark:text-blue-400">star-cliproxy</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('sidebar.subtitle')}</p>
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
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`
              }
            >
              <span className="font-mono text-xs w-4 text-center">{item.icon}</span>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </div>

        {/* 하단: 언어 토글 + 테마 토글 */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-800 space-y-2">
          <div className="flex items-center justify-between">
            {/* 언어 토글 */}
            <button
              onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors
                bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400
                hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200"
              title={lang === 'ko' ? 'Switch to English' : '한국어로 전환'}
            >
              {lang === 'ko' ? 'EN' : '한'}
            </button>

            {/* 테마 토글 */}
            <button
              onClick={toggleTheme}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors
                bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400
                hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? (
                // 해 아이콘 (라이트 모드로 전환)
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                // 달 아이콘 (다크 모드로 전환)
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-600">
            v1.1.0 | Port 8300
          </div>
        </div>
      </nav>

      {/* 메인 콘텐츠 */}
      <main className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950 flex flex-col">
        {/* 상단 바 */}
        <div className="flex items-center justify-end gap-2 px-6 pt-4 pb-2">
          <button
            onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}
            aria-label={lang === 'ko' ? 'Switch to English' : '한국어로 전환'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
              bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800
              text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800
              hover:text-gray-800 dark:hover:text-gray-200"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
            </svg>
            {lang === 'ko' ? 'English' : '한국어'}
          </button>
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
              bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800
              text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800
              hover:text-gray-800 dark:hover:text-gray-200"
          >
            {theme === 'dark' ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
        <div className="flex-1 px-6 pb-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/models" element={<ModelMappingsPage />} />
          <Route path="/keys" element={<ApiKeysPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/rate-limits" element={<RateLimitsPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/debug" element={<DebugPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/guide" element={<ApiGuidePage />} />
        </Routes>
        </div>
      </main>
    </div>
  );
}

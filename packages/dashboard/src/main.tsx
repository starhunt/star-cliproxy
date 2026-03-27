import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { I18nProvider } from './i18n/context';
import { ThemeProvider } from './theme/context';
import { AdminAuthProvider } from './auth/context';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AdminAuthProvider>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </AdminAuthProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);

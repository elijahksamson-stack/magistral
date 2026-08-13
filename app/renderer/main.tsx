/**
 * Renderer entry point.
 *
 * StrictMode is deliberately OFF. Its double-invoked effects would fire the
 * store's bootstrap twice and create two vaults on first launch — the panes'
 * effects also drive a native layout loop that is not idempotent under
 * double-mount.
 */

import { createRoot } from 'react-dom/client';
import './shared/theme.css';
import './global.css';
import App from './App';
import { GraphStoreProvider } from './shared/store';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing #root — the renderer cannot mount.');
}

createRoot(container).render(
  <GraphStoreProvider>
    <App />
  </GraphStoreProvider>,
);

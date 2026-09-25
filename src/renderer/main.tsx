import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installBrowserBridge } from './browser-bridge';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
void (async () => {
  try {
    if (!window.shellmate) await installBrowserBridge();
    root.render(<React.StrictMode><App /></React.StrictMode>);
  } catch (error) {
    root.render(<div className="loading" role="alert">{error instanceof Error ? error.message : 'Shellmate browser host is unavailable.'}</div>);
  }
})();

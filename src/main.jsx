import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './prism-shell.css';
import './prism-pages.css';

const root = createRoot(document.getElementById('root'));
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('flute-preview')) {
  import('./flute/ProjectPreview.jsx').then(({ FluteProjectPreview }) => {
    root.render(<React.StrictMode><FluteProjectPreview enabled><App /></FluteProjectPreview></React.StrictMode>);
  });
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}

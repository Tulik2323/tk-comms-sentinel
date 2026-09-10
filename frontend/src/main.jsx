// main.jsx — נקודת כניסה
import { StrictMode } from 'react';
import { createRoot }  from 'react-dom/client';
import './lib/i18n';       // טעינת תרגומים
import './index.css';      // styles
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

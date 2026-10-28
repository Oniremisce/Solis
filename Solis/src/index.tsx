import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// src/index.tsx — TV 壳入口。

createRoot(document.getElementById('root')!).render(<App />);

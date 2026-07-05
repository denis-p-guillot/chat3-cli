import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startAppVersionWatcher } from './lib/appVersion'
import './index.css'
import App from './App.tsx'

startAppVersionWatcher()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

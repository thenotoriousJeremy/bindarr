import React from 'react'
import ReactDOM from 'react-dom/client'
import './apiBase.js' // installs native fetch shim before any request
import './nativeInit.js' // Capacitor status-bar setup (no-op on web)
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

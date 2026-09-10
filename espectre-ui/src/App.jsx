import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const MAX_HISTORY = 60  // keep last 60 motion scores for the chart

function useDevice() {
  const [device, setDevice]     = useState(null)
  const [sensing, setSensing]   = useState(null)
  const [wifi, setWifi]         = useState(null)
  const [health, setHealth]     = useState(null)
  const [connected, setConnected] = useState(false)
  const [error, setError]       = useState(null)
  const esRef = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [d, s, w, h] = await Promise.all([
        fetch('/api/device').then(r => r.json()),
        fetch('/api/sensing').then(r => r.json()),
        fetch('/api/wifi').then(r => r.json()),
        fetch('/api/health').then(r => r.json()),
      ])
      setDevice(d)
      setSensing(s)
      setWifi(w)
      setHealth(h)
      setConnected(true)
      setError(null)
    } catch (e) {
      setConnected(false)
      setError('Cannot reach device. Check the IP in vite.config.js')
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  return { device, sensing, setSensing, wifi, health, connected, error, fetchAll }
}

function useMotionStream(onMotion) {
  const esRef = useRef(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    esRef.current = es

    es.addEventListener('motion', e => {
      try { onMotion(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('sensing', e => {
      try { onMotion({ _sensing: JSON.parse(e.data) }) } catch {}
    })
    es.onerror = () => {}

    return () => es.close()
  }, [onMotion])
}

function ScoreChart({ history, threshold }) {
  const W = 600, H = 120, PAD = 8

  if (history.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        <text x={W / 2} y={H / 2} textAnchor="middle" fill="#888" fontSize="13">
          Waiting for data…
        </text>
      </svg>
    )
  }

  const xs = history.map((_, i) => PAD + (i / (MAX_HISTORY - 1)) * (W - PAD * 2))
  const ys = history.map(v => H - PAD - v * (H - PAD * 2))
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ')
  const fillPts = `${xs[0]},${H - PAD} ` + pts + ` ${xs[xs.length - 1]},${H - PAD}`
  const ty = H - PAD - threshold * (H - PAD * 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* threshold line */}
      <line x1={PAD} y1={ty} x2={W - PAD} y2={ty} stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 3" />
      <text x={W - PAD - 2} y={ty - 4} fill="#f59e0b" fontSize="10" textAnchor="end">threshold</text>
      {/* fill */}
      <polygon points={fillPts} fill="url(#grad)" />
      {/* line */}
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`stat-card ${accent ? 'accent-' + accent : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? '—'}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function PresenceBadge({ state }) {
  const map = {
    motion: { label: 'MOVING', cls: 'badge-motion' },
    idle:   { label: 'IDLE',   cls: 'badge-idle' },
  }
  const { label, cls } = map[state] ?? { label: '…', cls: 'badge-wait' }
  return <span className={`badge ${cls}`}>{label}</span>
}

function ThresholdSlider({ value, onChange }) {
  return (
    <div className="slider-row">
      <label>Threshold <span className="slider-val">{value?.toFixed(2)}</span></label>
      <input
        type="range" min="0" max="1" step="0.01"
        value={value ?? 0.5}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

export default function App() {
  const { device, sensing, setSensing, wifi, health, connected, error, fetchAll } = useDevice()
  const [history, setHistory]   = useState([])
  const [lastMotion, setLastMotion] = useState(null)
  const [calibrating, setCalibrating] = useState(false)
  const [clearingWifi, setClearingWifi] = useState(false)
  const [clearingBssid, setClearingBssid] = useState(false)
  const [theme, setTheme] = useState('dark')
  const [threshold, setThreshold] = useState(0.5)

  // sync threshold from device
  useEffect(() => {
    if (sensing?.threshold != null) setThreshold(sensing.threshold)
  }, [sensing?.threshold])

  const handleMotion = useCallback(evt => {
    if (evt._sensing) { setSensing(evt._sensing); return }
    setLastMotion(evt)
    setHistory(h => [...h.slice(-(MAX_HISTORY - 1)), evt.score ?? 0])
  }, [setSensing])

  useMotionStream(handleMotion)

  const applyThreshold = async (val) => {
    setThreshold(val)
    await fetch('/api/sensing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: val }),
    }).catch(() => {})
  }

  const recalibrate = async () => {
    setCalibrating(true)
    await fetch('/api/sensing/calibrations', { method: 'POST' }).catch(() => {})
    setTimeout(() => { setCalibrating(false); fetchAll() }, 12000)
  }

  const clearWifiConfig = async () => {
    setClearingWifi(true)
    try {
      await fetch('/api/wifi/credentials', { method: 'DELETE' })
      await fetchAll()
    } catch (_) {}
    setClearingWifi(false)
  }

  const clearBssid = async () => {
    setClearingBssid(true)
    try {
      await fetch('/api/wifi/bssid', { method: 'DELETE' })
      await fetchAll()
    } catch (_) {}
    setClearingBssid(false)
  }

  const motionState = lastMotion?.state ?? 'idle'
  const score       = lastMotion?.score ?? 0

  return (
    <div className={`app theme-${theme} shell`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo">◈</span>
          <span className="brand-name">Presence Detector</span>
        </div>

        {/* <div className="side-project">
          <span className="project-kicker">Project</span>
          <span className="project-title">Presence Detector</span>
        </div> */}

        <nav className="sidebar-nav">
          <span className="nav-link active">Overview</span>
          <span className="nav-link">Sensing</span>
          <span className="nav-link">Network</span>
          <span className="nav-link">Diagnostics</span>
        </nav>

        <div className="sidebar-footer">
          <div className="header-actions">
            <button className="icon-btn" onClick={fetchAll}>↻</button>
            <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'}</button>
          </div>

          <div className="header-status">
            <span className={`dot ${connected ? 'dot-ok' : 'dot-err'}`} />
            <span>{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {error && (
          <div className="error-banner">
            ⚠ {error}
          </div>
        )}

        {connected && (
          <>
            <section className="project-strip">
              <div>
                <span className="project-kicker">Project / Live Room</span>
                <span className="project-title">{device?.name ?? 'ESPectre Device'}</span>
              </div>
              <div className="project-meta">
                <span>{device?.chip ?? 'ESP32'}</span>
                <span className="meta-sep">•</span>
                <span>{device?.frontend ?? 'Native'}</span>
              </div>
            </section>

            {/* ── Presence hero ── */}
            <section className="hero">
              <div className="hero-state">
                <PresenceBadge state={motionState} />
                <div className="hero-score">
                  <span className="score-num">{(score * 100).toFixed(1)}</span>
                  <span className="score-unit">% movement</span>
                </div>
              </div>
              <div className="hero-chart">
                <ScoreChart history={history} threshold={threshold} />
                <div className="chart-label">Last {MAX_HISTORY} readings · threshold line in amber</div>
              </div>
            </section>

            {/* ── Controls ── */}
            <section className="controls">
              <ThresholdSlider value={threshold} onChange={applyThreshold} />
              <div className="button-row">
                <button
                  className={`btn ${calibrating ? 'btn-busy' : 'btn-secondary'}`}
                  onClick={recalibrate}
                  disabled={calibrating}
                >
                  {calibrating ? '⟳ Calibrating…' : 'Recalibrate Room'}
                </button>
                <button
                  className={`btn ${clearingBssid ? 'btn-busy' : 'btn-tertiary'}`}
                  onClick={clearBssid}
                  disabled={clearingBssid}
                >
                  {clearingBssid ? 'Clearing BSSID…' : 'Clear BSSID'}
                </button>
                <button
                  className={`btn ${clearingWifi ? 'btn-busy' : 'btn-danger'}`}
                  onClick={clearWifiConfig}
                  disabled={clearingWifi}
                >
                  {clearingWifi ? 'Clearing Wi-Fi…' : 'Clear Wi-Fi'}
                </button>
              </div>
            </section>

            {/* ── Stats grid ── */}
            <section className="stats">
              <StatCard label="Device"    value={device?.name}     sub={device?.chip} />
              <StatCard label="Firmware"  value={device?.firmware} sub={device?.frontend} />
              <StatCard label="Detector"  value={sensing?.detector} sub={sensing?.calibrating ? 'calibrating' : sensing?.ready ? 'ready' : 'not ready'} />
              <StatCard label="Uptime"    value={health?.uptime_s != null ? `${Math.floor(health.uptime_s / 60)}m ${health.uptime_s % 60}s` : null} />
              <StatCard label="Wi-Fi"     value={wifi?.ssid}       sub={`ch ${wifi?.channel} · ${wifi?.rssi_dbm} dBm`} />
              <StatCard label="IP"        value={wifi?.ip}         sub={wifi?.band ? `${wifi.band} band` : null} />
              <StatCard label="CSI Mode"  value={sensing?.csi_traffic_mode} sub={sensing?.traffic_generator_mode} />
              <StatCard label="Target PPS" value={sensing?.csi_target_pps} sub="packets/sec" />
            </section>
          </>
        )}
      </main>
    </div>
  )
}

import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import "./App.css";
const PresenceScene = lazy(() => import("./PresenceScene"));

const MAX_HISTORY = 60;

// ── Hooks ──────────────────────────────────────────────────────────────────

function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return [theme, toggle];
}

function useDevice() {
  const [device, setDevice] = useState(null);
  const [sensing, setSensing] = useState(null);
  const [wifi, setWifi] = useState(null);
  const [health, setHealth] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [d, s, w, h] = await Promise.all([
        fetch("/api/device").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch("/api/sensing").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch("/api/wifi").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch("/api/health").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      ]);
      setDevice(d);
      setSensing(s);
      setWifi(w);
      setHealth(h);
      setConnected(true);
      setError(null);
    } catch {
      setConnected(false);
      setError("Cannot reach device. Check DEVICE_IP in server.js");
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const timer = setInterval(fetchAll, 5000);
    return () => clearInterval(timer);
  }, [fetchAll]);
  return {
    device,
    sensing,
    setSensing,
    wifi,
    health,
    connected,
    error,
    fetchAll,
  };
}

function usePresenceStream(onPresence, onMotion, onSensing) {
  useEffect(() => {
    let es;
    function connect() {
      es = new EventSource("/api/events");
      es.addEventListener("presence", (e) => {
        try {
          const value = JSON.parse(e.data);
          if (localStorage.getItem("DEBUG_LIVE") === "1")
            console.debug("[live] frontend received", value);
          onPresence(value);
        } catch (err) {
          console.warn("Invalid presence event", err);
        }
      });
      es.addEventListener("motion", (e) => {
        try {
          onMotion(JSON.parse(e.data));
        } catch {}
      });
      es.addEventListener("sensing", (e) => {
        try {
          onSensing(JSON.parse(e.data));
        } catch {}
      });
      es.onerror = () => {
        onPresence({
          presence_state: "UNKNOWN",
          activity: "ACTIVITY_UNKNOWN",
          sensor_status: "not_ready",
          stream_status: "disconnected",
          reason: "backend_disconnected",
        });
      };
    }
    connect();
    return () => es && es.close();
  }, [onPresence, onMotion, onSensing]);
}

// ── Small components ───────────────────────────────────────────────────────

function PresenceBadge({ state }) {
  const map = {
    PRESENT_MOVING: {
      label: "Moving",
      cls: "badge-moving",
      dot: "pdot-moving",
    },
    PRESENT_STATIONARY: {
      label: "Stationary",
      cls: "badge-stationary",
      dot: "pdot-stationary",
    },
    POSSIBLE_EMPTY: {
      label: "Possibly Empty",
      cls: "badge-empty",
      dot: "pdot-empty",
    },
    UNKNOWN: { label: "Unknown", cls: "badge-unknown", dot: "pdot-unknown" },
  };
  const { label, cls, dot } = map[state] ?? map.UNKNOWN;
  return (
    <span className={`presence-badge ${cls}`}>
      <span className={`presence-dot ${dot}`} />
      {label}
    </span>
  );
}

function ActivityBadge({ activity }) {
  const map = {
    ACTIVITY_HIGH: { label: "High", cls: "act-high" },
    ACTIVITY_MEDIUM: { label: "Medium", cls: "act-medium" },
    ACTIVITY_LOW: { label: "Low", cls: "act-low" },
    ACTIVITY_UNKNOWN: { label: "Unknown", cls: "act-unknown" },
  };
  const { label, cls } = map[activity] ?? map.ACTIVITY_UNKNOWN;
  return <span className={`activity-badge ${cls}`}>{label}</span>;
}

function ScoreBar({ label, value, className }) {
  return (
    <div className="score-row">
      <div className="score-label">
        <span>{label}</span>
        <span>{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="score-bar-bg">
        <div
          className={`score-bar-fill ${className ?? ""}`}
          style={{ width: `${value * 100}%` }}
        />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? "—"}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ScoreChart({ history, threshold }) {
  const W = 800, H = 150;
  const left = 42, right = 780, top = 14, bottom = 122;
  const y = value => bottom - Math.max(0, Math.min(1, value)) * (bottom - top);
  const points = history.map((value, index) => ({
    x: left + ((MAX_HISTORY - history.length + index) / (MAX_HISTORY - 1)) * (right - left),
    y: y(value),
  }));
  const line = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  const last = points[points.length - 1];
  const area = points.length > 1 ? `${line} L ${last.x} ${bottom} L ${points[0].x} ${bottom} Z` : "";
  return (
    <div className="signal-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Motion scores for the last ${history.length} readings. Threshold ${threshold.toFixed(2)}.`}>
        <defs>
          <linearGradient id="signal-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent2)" stopOpacity=".25" />
            <stop offset="100%" stopColor="var(--accent2)" stopOpacity=".015" />
          </linearGradient>
        </defs>
        {[1, 0.75, 0.5, 0.25, 0].map(value => (
          <g key={value}>
            <line className="signal-grid" x1={left} x2={right} y1={y(value)} y2={y(value)} />
            <text className="signal-axis" x={left - 12} y={y(value) + 4} textAnchor="end">{value.toFixed(2)}</text>
          </g>
        ))}
        {area && <path d={area} fill="url(#signal-area)" />}
        <line className="signal-threshold" x1={left} x2={right} y1={y(threshold)} y2={y(threshold)} />
        {points.length > 1 && <path className="signal-line" d={line} />}
        {last && <g>
          <circle cx={last.x} cy={last.y} r="9" fill="var(--accent2)" opacity=".15" />
          <circle className="signal-tip" cx={last.x} cy={last.y} r="4" />
        </g>}
        {!last && <text className="signal-empty" x={(left + right) / 2} y="72" textAnchor="middle">Waiting for signal data</text>}
        <text className="signal-axis" x={left} y="144">{MAX_HISTORY - 1} readings ago</text>
        <text className="signal-axis" x={(left + right) / 2} y="144" textAnchor="middle">30 readings ago</text>
        <text className="signal-axis" x={right} y="144" textAnchor="end">Latest</text>
      </svg>
    </div>
  );
}

// ── Calibration panel ──────────────────────────────────────────────────────

function CalibrationPanel({ sensorReady }) {
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [samples, setSamples] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const start = async () => {
    if (!confirmed) {
      setError("Please confirm the area is empty first.");
      return;
    }
    setError(null);
    setResult(null);
    const r = await fetch("/api/calibration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    }).then((x) => x.json());
    if (!r.ok) {
      setError(r.message || r.reason || "Failed to start");
      return;
    }
    setRunning(true);
    setProgress(0);
    setSamples(0);
    pollRef.current = setInterval(async () => {
      const cal = await fetch("/api/calibration")
        .then((x) => x.json())
        .catch(() => null);
      if (!cal) return;
      if (cal.active) {
        const pct = Math.min(
          100,
          Math.round(
            (100 * (cal.progress?.elapsed_ms ?? 0)) /
              (cal.progress?.duration_ms || 30000),
          ),
        );
        setProgress(pct);
        setSamples(cal.progress?.sample_count ?? 0);
      } else {
        clearInterval(pollRef.current);
        setRunning(false);
        setProgress(100);
        setResult(cal.result);
      }
    }, 1000);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  return (
    <div className="cal-wizard">
      <div className="cal-confirm-row">
        <input
          type="checkbox"
          id="cal-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={running}
        />
        <label htmlFor="cal-confirm" className="cal-confirm-text">
          I confirm the monitored sensing area is currently{" "}
          <strong>empty</strong>. Calibration will collect ~30 seconds of
          baseline data.
        </label>
      </div>

      {error && (
        <div style={{ color: "var(--red)", fontSize: 12 }}>{error}</div>
      )}

      {!running && !result && (
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={start}
            disabled={!confirmed || !sensorReady}
          >
            {sensorReady ? "Start Calibration" : "Sensor not ready"}
          </button>
        </div>
      )}

      {running && (
        <div className="cal-progress">
          <div className="cal-status-row">
            <span>Collecting baseline…</span>
            <span>{samples} samples</span>
          </div>
          <div className="cal-progress-bar-bg">
            <div
              className="cal-progress-bar-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="cal-status-row">
            <span style={{ color: "var(--text3)" }}>~30 seconds total</span>
            <span style={{ color: "var(--text3)" }}>{progress}%</span>
          </div>
        </div>
      )}

      {result && (
        <div>
          <div className={result.valid ? "cal-success" : "cal-fail"}>
            {result.valid
              ? "✓ Calibration complete"
              : "✗ Calibration failed — " + (result.reason ?? "unstable")}
          </div>
          {!result.valid && result.reason === "unstable_baseline" && (
            <p>
              Motion scores varied too much during the baseline recording. Keep
              the monitored area empty and the sensor fixed for the full 30
              seconds, then retry. Check for people, pets, fans, or other
              movement near the Wi-Fi sensing path.
            </p>
          )}
          {result.sample_count != null && (
            <div className="cal-result" style={{ marginTop: 10 }}>
              {[
                ["Samples", result.sample_count],
                [
                  "Duration",
                  result.duration_ms
                    ? `${(result.duration_ms / 1000).toFixed(0)}s`
                    : "—",
                ],
                ["Median score", result.median?.toFixed(4)],
                ["MAD", result.mad?.toFixed(4)],
                ["Std dev", result.std?.toFixed(4)],
                ["P95", result.p95?.toFixed(4)],
                ["Stability", result.stability?.toFixed(2)],
                [
                  "Quality",
                  result.stability >= 0.7
                    ? "Good"
                    : result.stability >= 0.3
                      ? "Fair"
                      : "Poor",
                ],
              ].map(([k, v]) => (
                <div className="cal-result-row" key={k}>
                  <span className="cal-result-key">{k}</span>
                  <span className="cal-result-val">{v ?? "—"}</span>
                </div>
              ))}
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setResult(null);
                setConfirmed(false);
                setProgress(0);
              }}
            >
              Recalibrate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Admin panel ──────────────────────────────────────────────────────────────

function useAdminApi() {
  const csrfRef = useRef(null)
  const api = useCallback(async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json' }
    if (csrfRef.current && method !== 'GET') headers['X-CSRF-Token'] = csrfRef.current
    const r = await fetch('/admin/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }, [])
  return { api, csrfRef }
}

function AdminPanel() {
  const { api, csrfRef } = useAdminApi()
  const [authed, setAuthed]         = useState(null)
  const [pw, setPw]                 = useState('')
  const [loginErr, setLoginErr]     = useState('')
  const [devices, setDevices]       = useState([])
  const [activeId, setActiveId]     = useState(null)
  const [notice, setNotice]         = useState(null)
  const [busy, setBusy]             = useState('')
  const [ports, setPorts]           = useState([])
  const [discovered, setDiscovered] = useState([])
  const [epInput, setEpInput]       = useState('')
  const [provPort, setProvPort]     = useState('')
  const [provSsid, setProvSsid]     = useState('')
  const [provPass, setProvPass]     = useState('')

  const flash = (text, ok = true) => { setNotice({ text, ok }); setTimeout(() => setNotice(null), 5000) }

  const loadDevices = useCallback(async () => {
    try { const d = await api('GET', '/devices'); setDevices(d.devices); setActiveId(d.active_id) } catch {}
  }, [api])

  useEffect(() => {
    api('GET', '/auth/session').then(s => {
      if (s.authenticated) { csrfRef.current = s.csrf; setAuthed(true); loadDevices() }
      else setAuthed(false)
    }).catch(() => setAuthed(false))
  }, [api, csrfRef, loadDevices])

  const login = async () => {
    setLoginErr('')
    try { const r = await api('POST', '/auth/login', { password: pw }); csrfRef.current = r.csrf; setPw(''); setAuthed(true); loadDevices() }
    catch (e) { setLoginErr(e.message) }
  }

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => {})
    csrfRef.current = null; setAuthed(false); setDevices([])
  }

  const addEndpoint = async () => {
    if (!epInput.trim()) return
    setBusy('add')
    try { const r = await api('POST', '/devices', { endpoint: epInput.trim() }); flash(`Added: ${r.device.name}`); setEpInput(''); await loadDevices() }
    catch (e) { flash(e.message, false) }
    setBusy('')
  }

  const activate = async id => {
    setBusy('act' + id)
    try { await api('POST', `/devices/${id}/activate`); await loadDevices(); flash('Device activated') }
    catch (e) { flash(e.message, false) }
    setBusy('')
  }

  const remove = async id => {
    if (!confirm('Remove this device?')) return
    try { await api('DELETE', `/devices/${id}`); await loadDevices() }
    catch (e) { flash(e.message, false) }
  }

  const scanSerial = async () => {
    setBusy('serial')
    try { const r = await api('GET', '/serial'); setPorts(r.ports) }
    catch (e) { flash(e.message, false) }
    setBusy('')
  }

  const discover = async () => {
    setBusy('discover'); setDiscovered([])
    try { const r = await api('GET', '/discover'); setDiscovered(r.devices) }
    catch (e) { flash(e.message, false) }
    setBusy('')
  }

  const provision = async () => {
    if (!provPort || !provSsid || !provPass) { flash('Select a port and enter SSID + password', false); return }
    setBusy('prov')
    flash('Provisioning… up to 70 seconds')
    try {
      const r = await api('POST', '/provision', { port: provPort, ssid: provSsid, password: provPass })
      setProvPass(''); flash(`Provisioned! ${r.endpoint}`); await loadDevices()
    } catch (e) { flash(e.message, false) }
    setBusy('')
  }

  if (authed === null) return <div style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>Checking session…</div>

  if (!authed) return (
    <div className="adm-login-wrap">
      <div className="card">
        <div className="card-title">Administrator Login</div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Password</label>
          <input className="adm-input" type="password" value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && login()}
            placeholder="Admin password" autoFocus />
        </div>
        {loginErr && <div className="adm-notice adm-err" style={{ marginBottom: 10 }}>{loginErr}</div>}
        <div className="btn-row"><button className="btn btn-primary" onClick={login}>Sign in</button></div>
      </div>
    </div>
  )

  return (
    <>
      <div className="admin-session-actions">
        <button className="btn btn-secondary btn-sm" onClick={logout}>Sign out</button>
      </div>

      {notice && <div className={`adm-notice ${notice.ok ? 'adm-ok' : 'adm-err'}`}>{notice.text}</div>}

      <div className="card">
        <div className="card-title">Active Device</div>
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          {devices.find(d => d.id === activeId)
            ? `${devices.find(d => d.id === activeId).name} — ${devices.find(d => d.id === activeId).endpoint}`
            : 'Default (env DEVICE_IP)'}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Registered Devices</div>
        {devices.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>No devices registered yet.</div>
          : <div className="adm-list">
              {devices.map(d => (
                <div className="adm-row" key={d.id}>
                  <div className="adm-info">
                    <span className="adm-name">{d.name}</span>
                    <span className="adm-ep">{d.endpoint}{d.chip ? ` · ${d.chip}` : ''}</span>
                  </div>
                  <span className={`adm-badge ${d.id === activeId ? 'adm-badge-on' : 'adm-badge-off'}`}>
                    {d.id === activeId ? '● Active' : 'Idle'}
                  </span>
                  {d.id !== activeId &&
                    <button className="btn btn-primary btn-sm" disabled={busy === 'act' + d.id}
                      onClick={() => activate(d.id)}>Activate</button>}
                  <button className="btn btn-danger btn-sm" onClick={() => remove(d.id)}>✕</button>
                </div>
              ))}
            </div>
        }
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16 }}>
          <div className="card-title">Add by Endpoint</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="adm-input" value={epInput} onChange={e => setEpInput(e.target.value)}
              placeholder="http://192.168.1.x:62587"
              onKeyDown={e => e.key === 'Enter' && addEndpoint()} />
            <button className="btn btn-primary btn-sm" onClick={addEndpoint} disabled={busy === 'add'}>
              {busy === 'add' ? '…' : 'Test & Add'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Discover Devices (mDNS)</div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className="btn btn-secondary" onClick={discover} disabled={busy === 'discover'}>
            {busy === 'discover' ? 'Scanning…' : 'Scan Network'}
          </button>
        </div>
        {discovered.length > 0
          ? <div className="adm-list">
              {discovered.map((d, i) => (
                <div className="adm-row" key={i}>
                  <div className="adm-info">
                    <span className="adm-name">{d.name || d.device_id || 'Unknown'}</span>
                    <span className="adm-ep">{d.endpoint || d.address || ''}</span>
                  </div>
                  <button className="btn btn-secondary btn-sm"
                    onClick={() => api('POST', '/devices', { endpoint: d.endpoint || d.address })
                      .then(() => { flash(`Added`); loadDevices() }).catch(e => flash(e.message, false))}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          : <div style={{ fontSize: 12, color: 'var(--text3)' }}>Press Scan to find ESPectre devices on the network.</div>
        }
      </div>

      <div className="card">
        <div className="card-title">Wi-Fi Provisioning (Improv Serial)</div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className="btn btn-secondary" onClick={scanSerial} disabled={busy === 'serial'}>
            {busy === 'serial' ? 'Scanning…' : 'Scan USB Ports'}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field">
            <label>USB Port</label>
            <select className="adm-input" value={provPort} onChange={e => setProvPort(e.target.value)}>
              <option value="">— select port —</option>
              {ports.map(p => <option key={p.port} value={p.port}>{p.port} — {p.description}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Wi-Fi SSID</label>
            <input className="adm-input" value={provSsid} onChange={e => setProvSsid(e.target.value)} placeholder="Network name" />
          </div>
          <div className="field">
            <label>Wi-Fi Password</label>
            <input className="adm-input" type="password" value={provPass} onChange={e => setProvPass(e.target.value)} placeholder="Never stored" />
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={provision} disabled={busy === 'prov'}>
              {busy === 'prov' ? 'Provisioning…' : 'Provision Device'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Inference engine card ──────────────────────────────────────────────────────

function InferenceCard({ calResult }) {
  const rows = [
    ["Production Engine", "Temporal Rule Engine", "ok"],
    // ["Production ML Model", "Not Deployed", "off"],
    ["Live Input", "ESPectre Motion Score", "ok"],
    [
      "Empty Calibration",
      calResult?.valid ? "Applied" : "Not calibrated",
      calResult?.valid ? "ok" : "warn",
    ],
    ["Temporal Hysteresis", "Enabled", "ok"],
    ["Raw CSI Required", "No", "ok"],
    ["People Count Model", "Not Available", "off"],
  ];
  return (
    <div className="card">
      <div className="card-title">Inference Engine</div>
      <div className="inference-grid">
        {rows.map(([k, v, cls]) => (
          <div className="inference-row" key={k}>
            <span className="inference-key">{k}</span>
            <span className={`inference-val ${cls}`}>{v}</span>
          </div>
        ))}
      </div>
      <div className="flow-diagram" style={{ marginTop: 14 }}>
        <span>ESPectre CSI → Motion Score (0..1)</span>
        <span> ↓ Temporal Rule Engine</span>
        <span> ↓ Empty baseline calibration</span>
        <span> ↓ Hysteresis + hold timers</span>
        <span>
          UNKNOWN → PRESENT_MOVING → PRESENT_STATIONARY → POSSIBLE_EMPTY
        </span>
      </div>
    </div>
  );
}

function MLResearchCard() {
  return (
    <div className="card">
      <div className="card-title">ML Research</div>
      {/* <div className="ml-badge">OFFLINE ONLY — Not in production</div> */}
      <div className="ml-note">
        {/* No ML model is currently deployed for live inference. The production
        system uses the Temporal Rule Engine above. */}
        {/* <br />
        <br /> */}
        ML research (Moving vs Stationary, Empty vs Occupied) requires
        leakage-safe grouped cross-validation across independent physical
        sessions and environments. A model will only be deployed if it passes
        held-out-environment generalization tests and all required features can
        be reproduced from the live ESPectre API.
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const {
    device,
    sensing,
    setSensing,
    wifi,
    health,
    connected,
    error,
    fetchAll,
  } = useDevice();
  const [presence, setPresence] = useState(null);
  const [history, setHistory] = useState([]);
  const [transitions, setTransitions] = useState([]);
  const [threshold, setThreshold] = useState(0.5);
  const [activeTab, setActiveTab] = useState("overview");
  const [flashLog, setFlashLog] = useState("");
  const [flashing, setFlashing] = useState(false);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [clearingWifi, setClearingWifi] = useState(false);
  const [clearingBssid, setClearingBssid] = useState(false);
  const prevPresenceRef = useRef(null);

  useEffect(() => {
    if (sensing?.threshold != null) setThreshold(sensing.threshold);
  }, [sensing?.threshold]);

  const handlePresence = useCallback((p) => {
    setPresence(p);
    if (
      prevPresenceRef.current &&
      prevPresenceRef.current !== p.presence_state
    ) {
      setTransitions((t) => [
        {
          from: prevPresenceRef.current,
          to: p.presence_state,
          time: new Date().toLocaleTimeString(),
        },
        ...t.slice(0, 19),
      ]);
    }
    prevPresenceRef.current = p.presence_state;
  }, []);

  const handleMotion = useCallback((evt) => {
    setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), evt.score ?? 0]);
  }, []);

  const handleSensing = useCallback((s) => setSensing(s), [setSensing]);

  usePresenceStream(handlePresence, handleMotion, handleSensing);

  const applyThreshold = async (val) => {
    setThreshold(val);
    await fetch("/api/sensing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: val }),
    }).catch(() => {});
  };

  const clearWifi = async () => {
    setClearingWifi(true);
    try {
      await fetch("/api/wifi/credentials", { method: "DELETE" });
      await fetchAll();
    } catch {}
    setClearingWifi(false);
  };

  const clearBssid = async () => {
    setClearingBssid(true);
    try {
      await fetch("/api/wifi/bssid", { method: "DELETE" });
      await fetchAll();
    } catch {}
    setClearingBssid(false);
  };

  const connectWifi = async () => {
    if (!wifiSsid.trim() || !wifiPass.trim()) return;
    setWifiConnecting(true);
    setFlashLog("Sending Wi-Fi credentials via Improv Serial…");
    try {
      const r = await fetch("/api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: wifiSsid,
          password: wifiPass,
          chip: "s3",
          frontend: "native",
          port: "/dev/ttyACM0",
          timeout: 60,
        }),
      }).then((x) => x.json());
      setFlashLog(r.log || (r.ok ? "Done." : "Failed."));
      setWifiSsid("");
      setWifiPass("");
      await fetchAll();
    } catch {
      setFlashLog("Failed.");
    }
    setWifiConnecting(false);
  };

  const flashFirmware = async () => {
    setFlashing(true);
    setFlashLog("Flashing…");
    try {
      const r = await fetch("/api/flash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chip: "s3", backend: "auto", pull: "missing" }),
      }).then((x) => x.json());
      setFlashLog(r.ok ? "Flash complete." : `Failed. ${r.log ?? ""}`);
      await fetchAll();
    } catch {
      setFlashLog("Flash failed.");
    }
    setFlashing(false);
  };

  const presenceState = presence?.presence_state ?? "UNKNOWN";
  const activity = presence?.activity ?? "ACTIVITY_UNKNOWN";
  const motionScore = presence?.motion_score ?? 0;
  const smoothed = presence?.smoothed_motion_score ?? 0;
  const reason = presence?.reason ?? "startup";
  const sensorReady = presence?.sensor_status === "healthy";
  const calResult = presence?.calibration;

  const tabs = ["overview", "calibration", "inference", "diagnostics", "admin"];

  return (
    <div className={`shell ${theme}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo">◈</span>
          <span className="brand-name">Presence</span>
        </div>
        <nav className="sidebar-nav">
          {tabs.map((t) => (
            <button
              key={t}
              className={`nav-link ${activeTab === t ? "active" : ""}`}
              onClick={() => setActiveTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}

        </nav>
        <div className="sidebar-footer">
          <div className="conn-status">
            <span className={`dot ${connected ? "dot-ok" : "dot-err"}`} />
            <span>{connected ? "Device connected" : "Disconnected"}</span>
          </div>
          <div className="conn-status">
            <span className={`dot ${sensorReady ? "dot-ok" : "dot-warn"}`} />
            <span>{sensorReady ? "Sensing ready" : "Not ready"}</span>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="page-header">
          <div className="page-heading">
            <h1 className="page-title">{{
              overview: "Presence Dashboard",
              calibration: "Empty-Room Calibration",
              inference: "Inference Transparency",
              diagnostics: "Diagnostics",
              admin: "Device Administration",
            }[activeTab]}</h1>
            {activeTab === "overview" && <span className="page-sub">
              {device?.name ?? "ESPectre"} · {device?.chip ?? "ESP32-S3"}
            </span>}
          </div>
          <div className="header-actions">
            <button className="icon-btn" onClick={fetchAll} title="Refresh" aria-label="Refresh device data">↻</button>
            <button className="icon-btn" onClick={toggleTheme} title="Toggle theme"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </header>
        {error && <div className="error-banner">⚠ {error}</div>}

        {/* ── Overview ── */}
        {activeTab === "overview" && (
          <>
            <div className="hero-grid">
              <div className="card">
                <div className="card-title">Presence</div>
                <div className="presence-hero">
                  <PresenceBadge state={presenceState} />
                  <div className="presence-label">
                    {presenceState === "PRESENT_MOVING"
                      ? "Moving"
                      : presenceState === "PRESENT_STATIONARY"
                        ? "Stationary"
                        : presenceState === "POSSIBLE_EMPTY"
                          ? "Possibly Empty"
                          : "Unknown"}
                  </div>
                  <div className="presence-reason">
                    {reason.replace(/_/g, " ")}
                  </div>
                </div>
              </div>

              <div className="card activity-card">
                <div className="card-title">Activity</div>
                <div className="activity-row">
                  <span style={{ fontSize: 13, color: "var(--text2)" }}>
                    Level
                  </span>
                  <ActivityBadge activity={activity} />
                </div>
                <ScoreBar label="Motion score" value={motionScore} />
                <ScoreBar
                  label="Smoothed score"
                  value={smoothed}
                  className="smoothed"
                />
                <div className="activity-row" style={{ marginTop: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--text3)" }}>
                    People count
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text3)",
                    }}
                  >
                    Unknown
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text3)",
                    lineHeight: 1.5,
                  }}
                >
                  One ESP32 link cannot provide defensible people counting.
                </div>
              </div>
            </div>

            <div className="card chart-card">
              <div className="signal-header">
                <div>
                  <div className="signal-eyebrow">MOTION TELEMETRY</div>
                  <h2 className="signal-title">Live Signal</h2>
                  <p className="signal-subtitle">A rolling view of the last {MAX_HISTORY} readings</p>
                </div>
                <span className={`signal-status ${sensorReady ? "is-live" : ""}`}>
                  <span />{sensorReady ? "Live" : "Waiting for device"}
                </span>
              </div>
              <div className="signal-summary">
                <div className="signal-current">
                  <span className="signal-number">{history.length ? history[history.length - 1].toFixed(3) : "—"}</span>
                  <span className="signal-caption">Latest motion score</span>
                </div>
                <div className="signal-legend">
                  <span><i className="signal-key" />Motion score</span>
                  <span><i className="signal-key threshold" />Threshold {threshold.toFixed(2)}</span>
                </div>
              </div>
              <ScoreChart history={history} threshold={threshold} />
              <div className="slider-row" style={{ marginTop: 8 }}>
                <div className="slider-label">
                  <span>Motion threshold</span>
                  <span className="slider-val">{threshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={threshold}
                  onChange={(e) => applyThreshold(parseFloat(e.target.value))}
                />
              </div>
            </div>
            <Suspense fallback={<div className="card">Loading presence view…</div>}>
              <PresenceScene state={presenceState} ready={sensorReady} theme={theme}
                activity={activity} motionScore={presence?.motion_score} sensorStatus={presence?.sensor_status} />
            </Suspense>

            <div className="two-col">
              <div className="card">
                <div className="card-title">Recent Transitions</div>
                {transitions.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>
                    No transitions yet
                  </div>
                ) : (
                  <div className="history-list">
                    {transitions.map((t, i) => (
                      <div className="history-item" key={i}>
                        <span className="history-time">{t.time}</span>
                        <span
                          className="history-state"
                          style={{ color: "var(--text2)" }}
                        >
                          {t.from} → {t.to}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-title">Sensor Status</div>
                <div
                  className="stats-grid"
                  style={{ gridTemplateColumns: "1fr 1fr" }}
                >
                  <StatCard
                    label="Stream"
                    value={presence?.stream_status ?? "disconnected"}
                  />
                  <StatCard
                    label="Sensing"
                    value={sensorReady ? "Ready" : "Not ready"}
                  />
                  <StatCard
                    label="Last event"
                    value={
                      presence?.last_event_age_ms != null
                        ? `${presence.last_event_age_ms}ms`
                        : "—"
                    }
                  />
                  <StatCard
                    label="Detector"
                    value={sensing?.detector ?? "—"}
                    sub={sensing?.calibrating ? "calibrating" : null}
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Device Info</div>
              <div className="stats-grid">
                <StatCard
                  label="Device"
                  value={device?.name}
                  sub={device?.chip}
                />
                <StatCard
                  label="Firmware"
                  value={device?.firmware}
                  sub={device?.frontend}
                />
                <StatCard
                  label="Uptime"
                  value={
                    health?.uptime_s != null
                      ? `${Math.floor(health.uptime_s / 60)}m ${health.uptime_s % 60}s`
                      : null
                  }
                />
                <StatCard
                  label="Wi-Fi"
                  value={wifi?.ssid}
                  sub={`ch ${wifi?.channel} · ${wifi?.rssi_dbm} dBm`}
                />
                <StatCard label="IP" value={wifi?.ip} />
                <StatCard
                  label="Target PPS"
                  value={sensing?.csi_target_pps}
                  sub="packets/sec"
                />
                <StatCard
                  label="CSI Mode"
                  value={sensing?.csi_traffic_mode}
                  sub={sensing?.traffic_generator_mode}
                />
              </div>
            </div>
            {/* <Suspense fallback={<div className="card">Loading presence view…</div>}>
              <PresenceScene state={presenceState} ready={sensorReady} theme={theme}
                activity={activity} motionScore={presence?.motion_score} sensorStatus={presence?.sensor_status} />
            </Suspense> */}
          </>
        )}

        {/* ── Calibration ── */}
        {activeTab === "calibration" && (
          <>
            <div className="card">
              <div className="card-title">Calibration Wizard</div>
              <CalibrationPanel sensorReady={sensorReady} />
            </div>
            <div className="card">
              <div className="card-title">About Calibration</div>
              <div
                style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.7 }}
              >
                Calibration measures the RF environment when the monitored area
                is empty. The resulting baseline (median, MAD, P95) is used to
                derive adaptive motion thresholds. A higher baseline means more
                RF noise in your environment, so the engine raises the threshold
                to avoid false positives.
                <br />
                <br />
                <strong>Important:</strong> Calibration does not prove a person
                is absent. It only characterises the empty-room noise floor. The
                presence engine still requires sustained motion evidence to
                enter PRESENT_MOVING.
              </div>
            </div>
          </>
        )}

        {/* ── Inference ── */}
        {activeTab === "inference" && (
          <>
            <InferenceCard calResult={calResult} />
            <MLResearchCard />
          </>
        )}

        {/* ── Network ──
        {activeTab === "network" && (
          <>
            <div className="page-header">
              <span className="page-title">Network</span>
            </div>
            <div className="card">
              <div className="card-title">
                Wi-Fi Provisioning (Improv Serial)
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div className="field">
                  <label>SSID</label>
                  <input
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="Network name"
                  />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input
                    type="password"
                    value={wifiPass}
                    onChange={(e) => setWifiPass(e.target.value)}
                    placeholder="Wi-Fi password"
                  />
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={connectWifi}
                    disabled={wifiConnecting || !wifiSsid || !wifiPass}
                  >
                    {wifiConnecting ? "Connecting…" : "Connect Wi-Fi"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={clearBssid}
                    disabled={clearingBssid}
                  >
                    {clearingBssid ? "Clearing…" : "Clear BSSID"}
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={clearWifi}
                    disabled={clearingWifi}
                  >
                    {clearingWifi ? "Clearing…" : "Clear Wi-Fi Config"}
                  </button>
                </div>
              </div>
            </div>
            {flashLog && <div className="flash-log">{flashLog}</div>}
          </>
        )} */}

        {/* ── Diagnostics ── */}
        {activeTab === "diagnostics" && (
          <>
            <div className="card">
              <div className="card-title">Firmware</div>
              <div className="btn-row" style={{ marginBottom: 12 }}>
                <button
                  className="btn btn-secondary"
                  onClick={flashFirmware}
                  disabled={flashing}
                >
                  {flashing ? "Flashing…" : "Flash Firmware"}
                </button>
              </div>
              {flashLog && <div className="flash-log">{flashLog}</div>}
            </div>
            <div className="card">
              <div className="card-title">Raw Presence State</div>
              <pre
                style={{
                  fontSize: 11,
                  color: "var(--text2)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.6,
                }}
              >
                {JSON.stringify(presence, null, 2) ?? "No data yet"}
              </pre>
            </div>
          </>
        )}


        {/* ── Admin ── */}
        {activeTab === "admin" && <AdminPanel />}

      </main>
    </div>
  );
}

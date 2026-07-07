import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { loggedIn, refresh } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('Loading QR…');
  // Bumping this re-runs the effect below, fetching a fresh QR code.
  const [qrGen, setQrGen] = useState(0);

  useEffect(() => {
    if (loggedIn) {
      nav('/');
      return;
    }
    let alive = true;
    let timer: number | undefined;
    setStatus('Loading QR…');

    (async () => {
      try {
        const { url, qrcodeKey } = await api.loginQr();
        if (!alive) return;
        if (canvasRef.current) {
          await QRCode.toCanvas(canvasRef.current, url, { width: 240, margin: 1 });
        }
        setStatus('Scan with the Bilibili app');

        const poll = async () => {
          if (!alive) return;
          try {
            const r = await api.pollQr(qrcodeKey);
            if (r.loggedIn) {
              setStatus('Logged in!');
              await refresh();
              nav('/');
              return;
            }
            if (r.code === 86038) {
              setStatus('QR expired — tap Refresh to get a new one');
              return;
            }
            if (r.code === 86090) setStatus('Scanned — confirm on your phone');
          } catch {
            /* keep polling */
          }
          timer = window.setTimeout(poll, 2000);
        };
        timer = window.setTimeout(poll, 2000);
      } catch (e) {
        setStatus('Failed to load QR: ' + String(e));
      }
    })();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [loggedIn, nav, refresh, qrGen]);

  return (
    <div className="center">
      <h2>Log in to Bilibili</h2>
      <div className="qr-box">
        <canvas ref={canvasRef} />
      </div>
      <p className="muted">{status}</p>
      <button className="btn" onClick={() => setQrGen((g) => g + 1)}>
        ↻ Refresh QR code
      </button>
    </div>
  );
}

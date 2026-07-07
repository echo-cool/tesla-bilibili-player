import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function PasswordGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr('');
    try {
      const ok = await api.gateLogin(pw);
      if (ok) onUnlocked();
      else {
        setErr('Wrong password');
        setPw('');
      }
    } catch {
      setErr('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-brand">
          Tesla <b>哔哩</b>
        </div>
        <p className="muted">Enter the password to continue</p>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          enterKeyHint="go"
        />
        {err && <div className="gate-err">{err}</div>}
        <button className="btn btn-accent" type="submit" disabled={busy || !pw}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

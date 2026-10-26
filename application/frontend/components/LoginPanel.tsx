'use client';

import {useState} from 'react';
import {api, messageOf} from '@/lib/api';

// Email OTP sign-in (Better Auth), then the business session (/auth/complete).
export default function LoginPanel({onDone}: {onDone: () => void}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await task();
    } catch (error) {
      setMessage({kind: 'error', text: messageOf(error)});
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () => run(async () => {
    await api('/api/auth/email-otp/send-verification-otp', {method: 'POST', json: {email, type: 'sign-in'}});
    setCodeSent(true);
    setMessage({kind: 'ok', text: 'Code envoyé. En mode local, il se lit dans la boîte de test du backend.'});
  });

  // Local mode only (the backend answers 404 elsewhere): no code, the address is only declared.
  const quickLogin = () => run(async () => {
    await api('/dev/sessions', {method: 'POST', json: {name: name || 'Rédacteur', email, verified: true}});
    onDone();
  });

  const verify = () => run(async () => {
    await api('/api/auth/sign-in/email-otp', {method: 'POST', json: {email, otp, name: name || 'Rédacteur'}});
    await api('/auth/complete', {method: 'POST'});
    onDone();
  });

  return (
    <section className="card stack" aria-labelledby="login-title">
      <h2 id="login-title">Identification</h2>
      <p className="muted">Un code envoyé par e-mail vérifie que vous possédez l'adresse.</p>
      <div>
        <label htmlFor="name">Nom</label>
        <input id="name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="email">Adresse e-mail</label>
        <input id="email" type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="row">
        <button type="button" disabled={busy || !email} onClick={sendCode}>Recevoir un code</button>
      </div>
      {codeSent && (
        <div className="stack">
          <div>
            <label htmlFor="otp">Code reçu</label>
            <input id="otp" inputMode="numeric" value={otp} autoComplete="one-time-code" onChange={(e) => setOtp(e.target.value)} />
          </div>
          <button type="button" disabled={busy || !otp} onClick={verify}>Vérifier et ouvrir la session</button>
        </div>
      )}
      <div className="stack">
        <p className="muted">
          Mode local uniquement : connexion rapide sans code. L'adresse est seulement déclarée, elle n'est pas
          vérifiée, et le déploiement ne doit pas être ouvert au public.
        </p>
        <button type="button" className="secondary" disabled={busy || !email} onClick={quickLogin}>
          Connexion rapide (mode local)
        </button>
      </div>
      {message && <p role="status" className={`notice ${message.kind}`}>{message.text}</p>}
    </section>
  );
}

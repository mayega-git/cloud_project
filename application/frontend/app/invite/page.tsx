'use client';

import Link from 'next/link';
import {useCallback, useEffect, useState} from 'react';
import LoginPanel from '@/components/LoginPanel';
import {api, ApiError, messageOf, type InvitationPreview} from '@/lib/api';

// The invitation token travels in the URL fragment (#invite=...), so it is
// never sent to a server by the browser when the page loads.
function tokenFromHash(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get('invite');
}

export default function InvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  const checkSession = useCallback(async () => {
    try {
      await api('/projects');
      setSignedIn(true);
    } catch (error) {
      setSignedIn(false);
      if (!(error instanceof ApiError && error.status === 401)) setMessage({kind: 'error', text: messageOf(error)});
    }
  }, []);

  useEffect(() => {
    const value = tokenFromHash();
    setToken(value);
    if (!value) return;
    void (async () => {
      try {
        setPreview(await api<InvitationPreview>('/invitations/preview', {method: 'POST', json: {token: value}}));
      } catch (error) {
        setMessage({kind: 'error', text: messageOf(error)});
      }
    })();
    void checkSession();
  }, [checkSession]);

  async function accept() {
    setMessage(null);
    try {
      await api('/invitations/accept', {method: 'POST', json: {token}});
      setAccepted(true);
      setMessage({kind: 'ok', text: 'Invitation acceptée.'});
    } catch (error) {
      setMessage({kind: 'error', text: messageOf(error)});
    }
  }

  return (
    <>
      <h1>Invitation</h1>
      {token === null && <p className="notice error">Ce lien ne contient pas d'invitation.</p>}
      {message && <p role="status" className={`notice ${message.kind}`}>{message.text}</p>}
      {preview && (
        <section className="card stack" aria-labelledby="invite-title">
          <h2 id="invite-title">{preview.projectTitle}</h2>
          <p>Adresse invitée : <strong>{preview.email}</strong>. Droit : <strong>{preview.access}</strong>. État : {preview.state}.</p>
          <p className="muted">
            Ouvrir ce lien n'accorde aucun accès. Vous devez vérifier la même adresse, puis accepter explicitement.
          </p>
          {accepted ? <p><Link href="/">Voir mes projets</Link></p> : signedIn ? (
            <button type="button" onClick={accept}>Accepter avec mon adresse vérifiée</button>
          ) : null}
        </section>
      )}
      {preview && signedIn === false && (
        <LoginPanel onDone={() => { setMessage(null); void checkSession(); }} />
      )}
    </>
  );
}

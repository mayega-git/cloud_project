'use client';

import Link from 'next/link';
import {useCallback, useEffect, useState} from 'react';
import LoginPanel from '@/components/LoginPanel';
import {api, ApiError, messageOf, type Project} from '@/lib/api';

export default function Home() {
  const [status, setStatus] = useState<'loading' | 'anonymous' | 'ready'>('loading');
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [timeZone, setTimeZone] = useState('Africa/Abidjan');
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await api<Project[]>('/projects'));
      setStatus('ready');
    } catch (error) {
      setStatus('anonymous');
      if (!(error instanceof ApiError && error.status === 401)) {
        setMessage({kind: 'error', text: messageOf(error)});
      }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api<{title: string}>('/projects', {
        method: 'POST', json: {title, ownerTimeZone: timeZone}, idempotent: true,
      });
      setTitle('');
      setMessage({kind: 'ok', text: `Projet créé : ${created.title}`});
      await load();
    } catch (error) {
      setMessage({kind: 'error', text: messageOf(error)});
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') return <p>Chargement…</p>;

  return (
    <>
      <div className="topbar"><h1>Journal collaboratif</h1></div>
      {message && <p role="status" className={`notice ${message.kind}`}>{message.text}</p>}
      {status === 'anonymous' ? (
        <LoginPanel onDone={() => { setMessage(null); void load(); }} />
      ) : (
        <>
          <section className="card stack" aria-labelledby="create-title">
            <h2 id="create-title">Créer un projet</h2>
            <div className="row">
              <input aria-label="Titre" placeholder="Titre" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input aria-label="Fuseau IANA" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
              <button type="button" disabled={busy || !title.trim()} onClick={create}>Créer</button>
            </div>
            <p className="muted">Le fuseau (par exemple Africa/Abidjan) fixe l'heure de clôture quotidienne ; il ne se change pas ensuite.</p>
          </section>
          <section className="card" aria-labelledby="projects-title">
            <h2 id="projects-title">Mes projets</h2>
            {projects.length === 0 ? <p className="muted">Aucun projet pour l'instant.</p> : (
              <ul className="plain">
                {projects.map((project) => (
                  <li key={project.projectId}>
                    <Link href={`/projects/${project.projectId}`}>{project.title}</Link>{' '}
                    <span className="badge">{project.isOwner ? 'propriétaire' : 'collaborateur'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

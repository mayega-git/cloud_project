'use client';

import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useCallback, useEffect, useState} from 'react';
import {
  api, messageOf, type Access, type Collaborator, type DownloadLink, type Invitation, type Project, type Version,
} from '@/lib/api';

// The editor gateway listens on port 9001 of the same host unless overridden.
function editorOrigin(): string {
  return process.env.NEXT_PUBLIC_EDITOR_ORIGIN ?? `${location.protocol}//${location.hostname}:9001`;
}

export default function BranchPage() {
  const {projectId, branchId} = useParams<{projectId: string; branchId: string}>();
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [links, setLinks] = useState<DownloadLink[]>([]);
  const [maxDownloads, setMaxDownloads] = useState('500');
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteAccess, setInviteAccess] = useState<Access>('WRITE');
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  const loadSharing = useCallback(async () => {
    const [pending, people] = await Promise.all([
      api<Invitation[]>(`/branches/${branchId}/invitations`),
      api<Collaborator[]>(`/branches/${branchId}/collaborators`),
    ]);
    setInvitations(pending);
    setCollaborators(people);
    setLinks(await api<DownloadLink[]>(`/branches/${branchId}/download-links`));
  }, [branchId]);

  useEffect(() => {
    setOrigin(editorOrigin());
    void (async () => {
      try {
        const details = await api<Project>(`/projects/${projectId}`);
        setProject(details);
        setVersions(await api<Version[]>(`/branches/${branchId}/versions`));
        if (details.isOwner) await loadSharing();
      } catch (e) {
        setMessage({kind: 'error', text: messageOf(e)});
      }
    })();
  }, [projectId, branchId, loadSharing]);

  async function act(task: () => Promise<void>, success?: string) {
    setMessage(null);
    try {
      await task();
      if (success) setMessage({kind: 'ok', text: success});
    } catch (e) {
      setMessage({kind: 'error', text: messageOf(e)});
    }
  }

  const invite = () => act(async () => {
    const result = await api<{emailStatus: string}>(`/branches/${branchId}/invitations`, {
      method: 'POST', json: {email: inviteEmail, access: inviteAccess}, idempotent: true,
    });
    setInviteEmail('');
    await loadSharing();
    setMessage({
      kind: result.emailStatus === 'SENT' ? 'ok' : 'error',
      text: result.emailStatus === 'SENT' ? 'Invitation envoyée.' : 'Invitation enregistrée ; l\'envoi a échoué, renvoyez-la.',
    });
  });

  const createLink = () => act(async () => {
    const created = await api<{url: string}>(`/branches/${branchId}/download-links`, {
      method: 'POST', json: {maxDownloads: Number(maxDownloads)},
    });
    setNewLinkUrl(created.url);
    await loadSharing();
  });

  const isOwner = project?.isOwner === true;

  return (
    <>
      <p><Link href={`/projects/${projectId}`}>← {project?.title ?? 'Projet'}</Link></p>
      <h1>Branche</h1>
      {message && <p role="status" className={`notice ${message.kind}`}>{message.text}</p>}

      <section className="card" aria-labelledby="versions-title">
        <h2 id="versions-title">Versions</h2>
        <ul className="plain">
          {versions.map((version) => (
            <li key={version.id}>
              <div className="row">
                <strong>V{version.number}</strong>
                <span className="badge">{version.state}</span>
                {version.state === 'FROZEN' && <span className="muted">figée</span>}
                {origin && (
                  <a href={`${origin}/p/${encodeURIComponent(version.padId)}`} target="_blank" rel="noopener noreferrer">
                    Ouvrir l'éditeur
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
        {/* The editor opens in its own tab: Etherpad refuses to run in a cross-origin
            iframe over plain HTTP (its preference cookie needs SameSite=None, hence HTTPS). */}
        <p className="muted">
          L'édition s'arrête si la version est figée ou si votre droit est retiré ; le texte refusé reste
          récupérable dans le panneau de l'éditeur.
        </p>
      </section>

      {isOwner && (
        <section className="card stack" aria-labelledby="links-title">
          <h2 id="links-title">Liens de téléchargement</h2>
          <p className="muted">
            Un lien donne le document au format PDF, tel qu'il est au moment du téléchargement, un nombre
            de fois limité. Le lien ne change pas quand le document est corrigé.
          </p>
          <div className="row">
            <input aria-label="Nombre de téléchargements autorisés" type="number" min={1} max={1000000}
              value={maxDownloads} onChange={(e) => setMaxDownloads(e.target.value)} />
            <button type="button" disabled={!maxDownloads} onClick={createLink}>Créer un lien</button>
          </div>
          {newLinkUrl && (
            <p className="notice ok">
              Lien créé, à copier maintenant (il ne sera plus affiché) : <a href={newLinkUrl}>{newLinkUrl}</a>
            </p>
          )}
          {links.length === 0 ? <p className="muted">Aucun lien.</p> : (
            <ul className="plain">
              {links.map((item) => (
                <li key={item.id}>
                  <span className="badge">{item.remaining === 0 ? 'épuisé' : 'actif'}</span>{' '}
                  {item.remaining} restant(s) sur {item.maxDownloads}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {isOwner && (
        <section className="card stack" aria-labelledby="share-title">
          <h2 id="share-title">Partager cette branche</h2>
          <div className="row">
            <input aria-label="Adresse e-mail à inviter" type="email" placeholder="adresse@exemple.org"
              value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            <select aria-label="Droit" value={inviteAccess} onChange={(e) => setInviteAccess(e.target.value as Access)}>
              <option value="READ">Lecture</option>
              <option value="WRITE">Écriture</option>
            </select>
            <button type="button" disabled={!inviteEmail} onClick={invite}>Inviter</button>
          </div>

          <h3>Invitations</h3>
          {invitations.length === 0 ? <p className="muted">Aucune invitation.</p> : (
            <ul className="plain">
              {invitations.map((item) => (
                <li key={item.id}>
                  <div className="row">
                    <span>{item.email}</span>
                    <span className="badge">{item.access}</span>
                    <span className="badge">{item.state}</span>
                    <span className="muted">e-mail : {item.emailStatus}</span>
                    {(item.state === 'PENDING' || item.state === 'EXPIRED') && (
                      <button type="button" className="secondary"
                        onClick={() => act(async () => { await api(`/invitations/${item.id}/resend`, {method: 'POST', json: {}}); await loadSharing(); }, 'Invitation renvoyée.')}>
                        Renvoyer
                      </button>
                    )}
                    {item.state === 'PENDING' && (
                      <button type="button" className="danger"
                        onClick={() => act(async () => { await api(`/invitations/${item.id}`, {method: 'DELETE'}); await loadSharing(); }, 'Invitation annulée.')}>
                        Annuler
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>Collaborateurs</h3>
          {collaborators.length === 0 ? <p className="muted">Aucun collaborateur.</p> : (
            <ul className="plain">
              {collaborators.map((person) => (
                <li key={person.userId}>
                  <div className="row">
                    <span>{person.name} &lt;{person.email}&gt;</span>
                    <select aria-label={`Droit de ${person.name}`} value={person.access}
                      onChange={(e) => act(async () => {
                        await api(`/branches/${branchId}/collaborators/${person.userId}`, {method: 'PUT', json: {access: e.target.value}});
                        await loadSharing();
                      }, 'Droit modifié.')}>
                      <option value="READ">Lecture</option>
                      <option value="WRITE">Écriture</option>
                    </select>
                    <button type="button" className="danger"
                      onClick={() => act(async () => { await api(`/branches/${branchId}/collaborators/${person.userId}`, {method: 'DELETE'}); await loadSharing(); }, 'Accès retiré.')}>
                      Retirer l'accès
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

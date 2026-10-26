'use client';

import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useEffect, useState} from 'react';
import {api, messageOf, type Branch, type Project} from '@/lib/api';

export default function ProjectPage() {
  const {projectId} = useParams<{projectId: string}>();
  const [project, setProject] = useState<Project | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setProject(await api<Project>(`/projects/${projectId}`));
        setBranches(await api<Branch[]>(`/projects/${projectId}/branches`));
      } catch (e) {
        setError(messageOf(e));
      }
    })();
  }, [projectId]);

  return (
    <>
      <p><Link href="/">← Mes projets</Link></p>
      <h1>{project?.title ?? 'Projet'}</h1>
      {error && <p role="alert" className="notice error">{error}</p>}
      <section className="card" aria-labelledby="branches-title">
        <h2 id="branches-title">Branches</h2>
        {branches.length === 0 && !error ? <p className="muted">Aucune branche accessible.</p> : (
          <ul className="plain">
            {branches.map((branch) => (
              <li key={branch.id}>
                <Link href={`/projects/${projectId}/branches/${branch.id}`}>Branche {branch.number}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

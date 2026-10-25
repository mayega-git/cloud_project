'use strict';

let editor;
let stopped = false;

function disableEditing() {
  try { editor?.setEditable?.(false); } catch { /* Server admission remains authoritative. */ }
  const body = document.querySelector('iframe[name="ace_outer"]')?.contentDocument
      ?.querySelector('iframe[name="ace_inner"]')?.contentDocument?.body;
  if (body) body.contentEditable = 'false';
}

exports.captureEditor = (_hook, {ace}) => {
  editor = ace;
};

setInterval(async () => {
  if (stopped) {
    disableEditing();
    return;
  }
  const padId = window.location.pathname.split('/')[2] || '';
  if (!padId) return;
  try {
    const response = await fetch(`/business-status/${encodeURIComponent(padId)}`, {credentials: 'same-origin'});
    if (!response.ok) return captureLocalText('Accès à cette version interrompu');
    const status = await response.json();
    if (status.state !== 'OPEN' || !status.write) captureLocalText('Cette version est en fermeture ou figée');
  } catch {
    captureLocalText('Connexion au serveur d’édition interrompue');
  }
}, 2000);

function captureLocalText(reason) {
  stopped = true;
  const padId = window.location.pathname.split('/')[2] || 'unknown';
  let text = '';
  try { text = editor?.exportText?.() || ''; } catch { /* Keep the panel available. */ }
  if (!text) {
    text = document.querySelector('iframe[name="ace_outer"]')?.contentDocument
        ?.querySelector('iframe[name="ace_inner"]')?.contentDocument?.body?.innerText || '';
  }
  if (text) localStorage.setItem(`business-recovery:${padId}`, text);
  const stored = localStorage.getItem(`business-recovery:${padId}`) || text;
  disableEditing();
  let panel = document.getElementById('business-recovery');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'business-recovery';
    panel.style.cssText = 'position:fixed;z-index:99999;top:1rem;right:1rem;max-width:34rem;padding:1rem;background:white;border:2px solid black;color:black';
    panel.innerHTML = '<strong>Édition arrêtée</strong><p>Ce texte est le document local complet, pas seulement les changements refusés. Ne recopiez que les passages nécessaires dans la version suivante.</p><textarea rows="10" style="width:100%"></textarea><button type="button">Télécharger le texte</button>';
    document.body.appendChild(panel);
    panel.querySelector('button').addEventListener('click', () => {
      const blob = new Blob([panel.querySelector('textarea').value], {type: 'text/plain'});
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${padId}-local-text.txt`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }
  panel.querySelector('strong').textContent = reason;
  panel.querySelector('textarea').value = stored;
}

exports.handleRejected = () => captureLocalText('Écriture refusée');
exports.handleClosing = () => captureLocalText('Cette version est en fermeture ou figée');

setTimeout(() => {
  const padId = window.location.pathname.split('/')[2] || '';
  if (padId && localStorage.getItem(`business-recovery:${padId}`)) {
    captureLocalText('Texte local récupéré');
  }
}, 1000);

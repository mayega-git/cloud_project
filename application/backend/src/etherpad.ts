import type {Config} from './config.js';

interface EtherpadResponse<T> {
  code: number;
  message: string;
  data: T;
}

export class EtherpadError extends Error {
  constructor(message: string, readonly upstreamCode?: number) {
    super(message);
  }
}

export class EtherpadClient {
  constructor(private readonly config: Config) {}

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams({apikey: this.config.etherpadApiKey, ...params});
    const url = new URL(`/api/1.3.1/${method}`, this.config.etherpadApiUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new EtherpadError('Etherpad is unavailable');
    }

    if (!response.ok) throw new EtherpadError(`Etherpad returned HTTP ${response.status}`);
    let payload: EtherpadResponse<T>;
    try {
      payload = await response.json() as EtherpadResponse<T>;
    } catch {
      throw new EtherpadError('Unreadable Etherpad response');
    }
    if (payload.code !== 0) {
      throw new EtherpadError(payload.message || 'Etherpad error', payload.code);
    }
    return payload.data;
  }

  async createPad(padID: string): Promise<void> {
    await this.call('createPad', {padID});
  }

  async getText(padID: string, revision?: number): Promise<string> {
    const data = await this.call<{text: string}>('getText', {padID, ...(revision === undefined ? {} : {rev: String(revision)})});
    if (typeof data?.text !== 'string') throw new EtherpadError('Etherpad text is missing');
    return data.text;
  }

  async getHtml(padID: string, revision?: number): Promise<string> {
    const data = await this.call<{html: string}>('getHTML', {padID, ...(revision === undefined ? {} : {rev: String(revision)})});
    if (typeof data?.html !== 'string') throw new EtherpadError('Etherpad HTML is missing');
    return data.html;
  }

  async revisionCount(padID: string): Promise<number> {
    const data = await this.call<{revisions: number}>('getRevisionsCount', {padID});
    return data.revisions;
  }

  async copyWithoutHistory(sourceID: string, destinationID: string): Promise<void> {
    await this.call('copyPadWithoutHistory', {sourceID, destinationID, force: 'false'});
  }

  async copyWithHistory(sourceID: string, destinationID: string): Promise<void> {
    await this.call('copyPad', {sourceID, destinationID, force: 'false'});
  }

  async restoreRevision(padID: string, revision: number): Promise<void> {
    await this.call('restoreRevision', {padID, rev: String(revision)});
  }

  async deletePad(padID: string): Promise<void> {
    await this.call('deletePad', {padID});
  }

  async announceClosing(padID: string): Promise<void> {
    await this.call('sendClientsMessage', {padID, msg: 'businessClosing'});
  }
}

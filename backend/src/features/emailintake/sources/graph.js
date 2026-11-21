// Microsoft Graph email source: one shared mailbox (e.g. hr-intake@city.gov) read with an
// app registration whose access is limited to that mailbox (see docs/capture/email.md).
//   list:  GET  /users/{mailbox}/mailFolders/inbox/messages   (oldest first)
//   fetch: GET  /users/{mailbox}/messages/{id}/$value         (the full MIME message → .eml)
//   move:  POST /users/{mailbox}/messages/{id}/move           (to Inbox/Processed or Inbox/Rejected)
const axios = require('axios');

const GRAPH = 'https://graph.microsoft.com/v1.0';

function graphSource({ tenantId, clientId, clientSecret, mailbox }, http = axios) {
  if (!tenantId || !clientId || !clientSecret || !mailbox) throw new Error('Microsoft Graph email intake needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_MAILBOX');
  const box = encodeURIComponent(mailbox);
  let token = null;
  let tokenExp = 0;
  const folders = {};

  async function auth() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const r = await http.post(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    token = r.data.access_token;
    tokenExp = Date.now() + (Number(r.data.expires_in) || 3600) * 1000;
    return token;
  }
  const call = async (method, url, data, extra = {}) => {
    const t = await auth();
    try {
      return await http.request({ method, url: `${GRAPH}${url}`, data, headers: { Authorization: `Bearer ${t}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...extra });
    } catch (e) {
      const status = e.response && e.response.status;
      const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
      // never echo the token or secret
      throw new Error(`Microsoft Graph ${method.toUpperCase()} failed${status ? ` (${status})` : ''}: ${msg}`);
    }
  };
  async function folderId(name) {
    if (folders[name]) return folders[name];
    const q = encodeURIComponent(`displayName eq '${name}'`);
    const found = await call('get', `/users/${box}/mailFolders/inbox/childFolders?$filter=${q}&$select=id,displayName`);
    let id = found.data.value && found.data.value[0] && found.data.value[0].id;
    if (!id) id = (await call('post', `/users/${box}/mailFolders/inbox/childFolders`, { displayName: name })).data.id;
    folders[name] = id;
    return id;
  }
  const move = async (id, name) => call('post', `/users/${box}/messages/${encodeURIComponent(id)}/move`, { destinationId: await folderId(name) });

  return {
    kind: 'graph',
    label: mailbox,
    async list(max = 50) {
      const r = await call('get', `/users/${box}/mailFolders/inbox/messages?$select=id,receivedDateTime,internetMessageId&$orderby=receivedDateTime asc&$top=${Math.min(100, max)}`);
      return (r.data.value || []).map((m) => ({ id: m.id, receivedAt: new Date(m.receivedDateTime), messageId: m.internetMessageId }));
    },
    async fetch(id) {
      const r = await call('get', `/users/${box}/messages/${encodeURIComponent(id)}/$value`, undefined, { responseType: 'arraybuffer' });
      return { raw: Buffer.from(r.data), format: 'eml' };
    },
    markProcessed: (id) => move(id, 'Processed'),
    markRejected: (id) => move(id, 'Rejected'),
  };
}

module.exports = { graphSource, GRAPH };

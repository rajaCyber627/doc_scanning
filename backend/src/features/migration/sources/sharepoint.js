// SharePoint / OneDrive source via Microsoft Graph (a document library = a drive).
// App-only access with Sites.Selected limited to the HR site; read-only.
const axios = require('axios');
const { Readable } = require('stream');

const GRAPH = 'https://graph.microsoft.com/v1.0';

function sharepointSource({ tenantId, clientId, clientSecret, driveId, folder = '' }, http = axios) {
  if (!tenantId || !clientId || !clientSecret || !driveId) throw new Error('SharePoint import needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and a drive id');
  let token = null;
  let exp = 0;
  const auth = async () => {
    if (token && Date.now() < exp - 60000) return token;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const r = await http.post(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    token = r.data.access_token;
    exp = Date.now() + (Number(r.data.expires_in) || 3600) * 1000;
    return token;
  };
  const get = async (url, extra = {}) => {
    const t = await auth();
    try {
      return await http.request({ method: 'get', url: url.startsWith('http') ? url : `${GRAPH}${url}`, headers: { Authorization: `Bearer ${t}` }, ...extra });
    } catch (e) {
      const status = e.response && e.response.status;
      throw new Error(`Microsoft Graph GET failed${status ? ` (${status})` : ''}: ${(e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message}`);
    }
  };
  const drive = `/drives/${encodeURIComponent(driveId)}`;
  const root = String(folder || '').replace(/^\/+|\/+$/g, '');
  const childrenUrl = (rel) => {
    const p = [root, rel].filter(Boolean).join('/');
    return p ? `${drive}/root:/${p.split('/').map(encodeURIComponent).join('/')}:/children?$top=200` : `${drive}/root/children?$top=200`;
  };
  return {
    kind: 'sharepoint',
    key: `sharepoint:${driveId}:${root}`,
    label: `SharePoint ${driveId}${root ? `/${root}` : ''}`,
    async *walk() {
      const stack = [''];
      while (stack.length) {
        const rel = stack.pop();
        let url = childrenUrl(rel);
        while (url) {
          const r = await get(url);
          for (const it of r.data.value || []) {
            const p = rel ? `${rel}/${it.name}` : it.name;
            if (it.folder) stack.push(p);
            else if (it.file) {
              const fsi = it.fileSystemInfo || {};
              yield {
                path: p,
                sourceId: it.id,
                size: Number(it.size) || 0,
                created: fsi.createdDateTime ? new Date(fsi.createdDateTime) : it.createdDateTime ? new Date(it.createdDateTime) : null,
                modified: fsi.lastModifiedDateTime ? new Date(fsi.lastModifiedDateTime) : it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime) : null,
                owner: (it.createdBy && it.createdBy.user && (it.createdBy.user.email || it.createdBy.user.displayName)) || '',
              };
            }
          }
          url = r.data['@odata.nextLink'] || null;
        }
      }
    },
    async read(item) {
      const r = await get(`${drive}/items/${encodeURIComponent(item.sourceId)}/content`, { responseType: 'arraybuffer' });
      return Buffer.from(r.data);
    },
    async stream(item) {
      return Readable.from([await this.read(item)]);
    },
  };
}

module.exports = { sharepointSource };

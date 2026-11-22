// The configured email source (EmailSource interface: list / fetch / markProcessed / markRejected).
const config = require('../../../core/config');
const { localSource } = require('./local');
const { graphSource } = require('./graph');

let override = null; // tests
let graph = null; // one client per process (keeps its token and folder ids)

function getEmailSource() {
  if (override) return override;
  const c = config.emailIntake;
  if (c.source === 'local') {
    if (!c.localDir) throw new Error('EMAIL_LOCAL_DIR is not set');
    return localSource(c.localDir);
  }
  if (c.source === 'graph') return (graph = graph || graphSource(c.graph));
  return null;
}
const setEmailSource = (s) => {
  override = s;
};

module.exports = { getEmailSource, setEmailSource };

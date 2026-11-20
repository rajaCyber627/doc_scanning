// Kept for the one-off scripts (backfill-embeddings.js, migrate-hash-passwords.js),
// which `await` this promise. The app itself connects via src/db.js.
const { connect } = require('./src/db');

module.exports = connect().catch((err) => console.log(err));

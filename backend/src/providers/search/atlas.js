// Atlas Search provider (placeholder). When the hub runs on MongoDB Atlas, create an
// Atlas Search index on the `searchdocs` collection, e.g.:
//   { "mappings": { "dynamic": false, "fields": {
//       "text": { "type": "string", "analyzer": "lucene.english" },
//       "fileName": { "type": "string" },
//       "userId": { "type": "objectId" }, "confidentiality": { "type": "token" },
//       "status": { "type": "token" }, "documentType": { "type": "token" },
//       "batchId": { "type": "objectId" }, "docCreatedAt": { "type": "date" } } } }
// and implement search() with a $search stage (compound: must text, filter on the
// access/status fields — the same visibility rules as providers/search/mongo.js),
// using Atlas "highlight" for snippets. Until then this provider refuses to run.
async function search() {
  throw new Error('SEARCH_PROVIDER=atlas is not implemented yet — use "mongo"');
}

module.exports = { search };

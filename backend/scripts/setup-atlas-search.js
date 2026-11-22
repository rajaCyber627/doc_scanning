#!/usr/bin/env node
// One-time setup on a MongoDB Atlas database: the vector search index "Ask everything"
// uses for semantic search across documents. Safe to re-run (an existing index is kept).
//   node scripts/setup-atlas-search.js
// Index: "vector_index" on chunks.embedding (1024 dimensions, cosine — Voyage voyage-4-lite)
// with userId as a filter (each user searches only their own documents).
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/core/config');

const DEFINITION = {
  name: 'vector_index',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
      { type: 'filter', path: 'userId' },
    ],
  },
};

(async () => {
  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db;
  if (!(await db.listCollections({ name: 'chunks' }).toArray()).length) await db.createCollection('chunks');
  const chunks = db.collection('chunks');
  let existing = [];
  try {
    existing = await chunks.listSearchIndexes().toArray();
  } catch (e) {
    throw new Error(`This database does not support Atlas Search indexes (${e.message}). Use a MongoDB Atlas cluster.`);
  }
  const found = existing.find((i) => i.name === DEFINITION.name);
  if (found) {
    console.log(`"${DEFINITION.name}" already exists — status: ${found.status || (found.queryable ? 'READY' : 'building')}`);
  } else {
    await chunks.createSearchIndex(DEFINITION);
    console.log(`Created "${DEFINITION.name}". Atlas builds it in about a minute.`);
  }
  for (let i = 0; i < 30; i++) {
    const idx = (await chunks.listSearchIndexes(DEFINITION.name).toArray())[0];
    if (idx && idx.queryable) {
      console.log('Ready: "Ask everything" can use semantic search.');
      break;
    }
    if (i === 29) console.log('Still building — it will become ready on its own.');
    await new Promise((r) => setTimeout(r, 4000));
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});

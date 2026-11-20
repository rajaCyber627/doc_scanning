// Shared test helpers: a throwaway in-memory MongoDB per test file.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

async function clearDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

const fixture = (name) => require('path').join(__dirname, 'fixtures', name);

module.exports = { startDb, clearDb, stopDb, fixture };

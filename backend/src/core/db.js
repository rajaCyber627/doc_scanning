const mongoose = require('mongoose');
const config = require('./config');

// Connect to MongoDB. Resolves once connected; logs "connected" like before.
function connect(uri = config.mongoUri) {
  return mongoose.connect(uri).then(() => {
    console.log('connected');
    return mongoose.connection;
  });
}

module.exports = { connect };

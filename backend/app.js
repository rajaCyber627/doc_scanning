// DocP backend entry point: connect to MongoDB, resume unfinished processing,
// and serve the API + built UI. App code lives in src/ (see docs/capture/CONTEXT.md).
const config = require('./src/config');
const { createApp } = require('./src/app');
const { connect } = require('./src/db');
const { recoverStuck } = require('./src/pipeline');

const app = createApp();

connect()
  .then(() => recoverStuck())
  .catch((err) => console.log(err));

app.listen(config.port, () => console.log(`Server is running on port ${config.port}`));

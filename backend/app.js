// DocP backend entry point: connect to MongoDB, resume unfinished processing,
// and serve the API + built UI. App code lives in src/ (see docs/capture/CONTEXT.md).
const config = require('./src/core/config');
const { createApp } = require('./src/app');
const { connect } = require('./src/core/db');
const { recoverStuck } = require('./src/features/intake/pipeline');
const hotFolders = require('./src/features/hotfolder/service');
const emailIntake = require('./src/features/emailintake/service');

const app = createApp();

connect()
  .then(() => recoverStuck())
  .then(() => hotFolders.start()) // scanner hot folders (P13)
  .then(() => emailIntake.start()) // email intake mailbox (P15)
  .catch((err) => console.log(err));

app.listen(config.port, () => console.log(`Server is running on port ${config.port}`));

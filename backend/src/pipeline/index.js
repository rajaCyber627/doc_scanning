// Public entry points for the intake pipeline.
const File = require('../models/File');
const config = require('../config');
const { InProcessQueue } = require('./queue');
const { runPipeline } = require('./runner');

const queue = new InProcessQueue({ concurrency: config.pipeline.concurrency });

/** Queue a document for processing. Returns immediately. */
function enqueueDocument(fileId, opts = {}) {
  queue
    .add(() => runPipeline(fileId, opts))
    .catch((e) => console.error('pipeline crashed for', String(fileId), e && e.message));
}

/** On start-up: resume documents left in "processing" (e.g. after a restart). */
async function recoverStuck() {
  const stuck = await File.find({ status: 'processing' }).select('_id').lean();
  stuck.forEach((f) => enqueueDocument(f._id));
  if (stuck.length) console.log(`pipeline: resumed ${stuck.length} document(s)`);
  return stuck.length;
}

/** Resolves when the queue is empty (tests). */
const onIdle = () => queue.onIdle();

module.exports = { enqueueDocument, recoverStuck, onIdle };

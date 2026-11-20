// pdf-parse, safely. pdf-parse hands its input straight to pdf.js, which reads the whole
// underlying ArrayBuffer. Small Node Buffers are slices of a shared memory pool, so pdf.js
// would read neighbouring bytes and fail at random ("bad XRef entry", "Unknown
// compression method"). A standalone copy makes every read deterministic.
const pdfParse = require('pdf-parse');

const isPassword = (e) => /password/i.test(`${e && e.name} ${e && e.message}`);
const own = (buffer) => new Uint8Array(buffer); // copies into its own ArrayBuffer

const parsePdf = (buffer, opts = {}) => pdfParse(own(buffer), opts);

module.exports = { parsePdf, isPassword };

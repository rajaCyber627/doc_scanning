// Documents that only hold other documents and are never filed themselves: a split
// original (its parts are filed, P11) or an email whose body has nothing to file (P15).
const isContainer = (f) => !!(f && ((f.splitInto && f.splitInto.length) || f.containerOnly));
// the same as a MongoDB filter (documents that are NOT containers)
const NOT_CONTAINER = { 'splitInto.0': { $exists: false }, containerOnly: { $ne: true } };

module.exports = { isContainer, NOT_CONTAINER };

// Who is asking, and what may they see. Until Entra ID SSO + roles arrive, permissions
// live on the User record (User.permissions). The one rule enforced everywhere today:
// restricted records (medical, FMLA, ADA, workers' comp, ER investigations, grievances)
// are invisible — not even counted — to users without the "restricted" permission.
const mongoose = require('mongoose');
const User = require('../models/User');

const RESTRICTED_PERMISSION = 'restricted';

/** Confidentiality levels that only permitted users may see. */
const RESTRICTED_LEVELS = ['restricted'];

async function viewerFor(userId) {
  if (!userId || !mongoose.isValidObjectId(userId)) return null;
  const user = await User.findById(userId).select('permissions role').lean();
  if (!user) return null;
  const perms = new Set(user.permissions || []);
  return {
    userId: String(userId),
    canSeeRestricted: perms.has(RESTRICTED_PERMISSION) || user.role === 'admin',
    isAdmin: perms.has('admin') || user.role === 'admin',
  };
}

/** MongoDB filter that hides restricted documents from viewers without permission. */
function visibilityFilter(viewer, field = 'confidentiality') {
  return viewer && viewer.canSeeRestricted ? {} : { [field]: { $nin: RESTRICTED_LEVELS } };
}

const isRestricted = (level) => RESTRICTED_LEVELS.includes(level);

module.exports = { viewerFor, visibilityFilter, isRestricted, RESTRICTED_PERMISSION, RESTRICTED_LEVELS };

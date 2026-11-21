#!/usr/bin/env node
// Give (or take away) a user's access rights. There is no UI for this on purpose: only
// someone with server access can make administrators.
//   node scripts/grant-access.js --email you@city.gov --admin --restricted
//   node scripts/grant-access.js --email you@city.gov --remove restricted
//   node scripts/grant-access.js --email you@city.gov            (show current rights)
//   admin      → Document types, AI settings, scanner folders, email intake, QC %, migrations
//   restricted → see and review medical / FMLA / ADA / workers' comp / employee-relations records
require('dotenv').config();
const { connect } = require('../src/core/db');
const User = require('../src/models/User');

const argv = process.argv.slice(2);
const val = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

(async () => {
  const email = String(val('email') || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: node scripts/grant-access.js --email <user email> [--admin] [--restricted] [--remove admin|restricted]');
  await connect();
  const user = await User.findOne({ email });
  if (!user) throw new Error(`No user with email ${email} — sign up in the app first`);
  const perms = new Set(user.permissions || []);
  if (argv.includes('--admin')) perms.add('admin');
  if (argv.includes('--restricted')) perms.add('restricted');
  if (val('remove')) perms.delete(val('remove'));
  user.permissions = [...perms];
  await user.save();
  console.log(`${email}: ${user.permissions.length ? user.permissions.join(', ') : 'no special rights'}`);
  console.log('Sign out and sign in again in the app to pick up the change.');
  process.exit(0);
})().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});

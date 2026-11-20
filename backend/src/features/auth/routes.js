const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const userModel = require('../../models/User');
const { sendOtpEmail, send2faEnabledEmail } = require('../../providers/email/smtp');

const isFilled = (v) => typeof v === 'string' && v.trim().length > 0;

// ===========================================================================
// Auth
// ===========================================================================
function safeUser(u) {
  const o = u && u.toObject ? u.toObject() : { ...(u || {}) };
  delete o.password;
  delete o.otp;
  delete o.otpExpires;
  return o;
}

router.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, userName, email, password } = req.body;
    if (!isFilled(email) || !isFilled(password))
      return res.status(400).json({ message: 'Email and password are required' });
    // Only match on values that were actually sent (an undefined value would be
    // dropped by Mongoose and match every user).
    const or = [{ email: String(email).trim() }];
    if (isFilled(userName)) or.push({ userName: String(userName).trim() });
    const existing = await userModel.find({ $or: or });
    if (existing.length > 0) return res.status(400).json({ message: 'Username or email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const newUser = await userModel.create({ firstName, lastName, userName, email, password: hashed });
    res.status(201).json({ message: 'Account created', userInfo: safeUser(newUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

const NUDGE_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

// Stored password is a bcrypt hash for new/migrated users. Any legacy plaintext
// value is compared directly and transparently upgraded to a hash on success.
async function verifyPassword(user, password) {
  if (user.password && user.password.startsWith('$2')) {
    return bcrypt.compare(password, user.password);
  }
  if (user.password === password) {
    user.password = await bcrypt.hash(password, 10);
    await user.save();
    return true;
  }
  return false;
}

router.post('/api/login', async (req, res) => {
  const { userNameorEmail, password } = req.body;
  // Without this check a missing identifier matched the FIRST user in the database.
  if (!isFilled(userNameorEmail) || !isFilled(password))
    return res.status(400).json({ message: 'Username/email and password are required' });
  try {
    const id = String(userNameorEmail).trim();
    const user = await userModel.findOne({ $or: [{ userName: id }, { email: id }] });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!(await verifyPassword(user, password)))
      return res.status(401).json({ message: 'Incorrect password' });

    // Two-step verification: email an OTP and require it before issuing the session.
    if (user.twoFactorEnabled) {
      const otp = genOtp();
      user.otp = otp;
      user.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
      await user.save();
      try {
        await sendOtpEmail(user.email, otp, user.firstName);
      } catch (e) {
        console.error('otp email failed:', e && e.message);
        return res.status(502).json({ message: 'Could not send the verification code. Try again later.' });
      }
      return res.status(200).json({ twoFactorRequired: true, userId: user._id, email: user.email });
    }

    // Not enrolled: nudge to enable 2FA at most once every 15 days.
    const last = user.lastTwoFactorNudge ? +new Date(user.lastTwoFactorNudge) : 0;
    const nudge2fa = Date.now() - last > NUDGE_MS;
    if (nudge2fa) {
      user.lastTwoFactorNudge = new Date();
      await user.save();
    }
    res.status(200).json({ message: 'Login successful', userInfo: safeUser(user), nudge2fa });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Step 2 of login when two-step verification is on
router.post('/api/login/verify-otp', async (req, res) => {
  try {
    const { userId, otp } = req.body;
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.otp || !user.otpExpires || user.otpExpires < new Date())
      return res.status(400).json({ message: 'Code expired — please sign in again' });
    if (String(otp).trim() !== user.otp) return res.status(401).json({ message: 'Incorrect code' });
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();
    res.status(200).json({ message: 'Login successful', userInfo: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Enable/disable two-step verification (from Settings)
router.post('/api/2fa', async (req, res) => {
  try {
    const { userId, enabled } = req.body;
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (enabled) {
      // Confirm email delivery works before turning it on (avoids lockout).
      try {
        await send2faEnabledEmail(user.email, user.firstName);
      } catch (e) {
        console.error('2fa enable email failed:', e && e.message);
        return res
          .status(502)
          .json({ message: 'Could not enable — we could not email your address. Try again later.' });
      }
      user.twoFactorEnabled = true;
    } else {
      user.twoFactorEnabled = false;
    }
    await user.save();
    res.status(200).json({ userInfo: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Custom instructions applied to every query
router.post('/api/user/instructions', async (req, res) => {
  try {
    const { userId, customInstructions } = req.body;
    const user = await userModel.findByIdAndUpdate(
      userId,
      { customInstructions: String(customInstructions || '').slice(0, 4000) },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ userInfo: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;

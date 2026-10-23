const bcrypt = require('bcryptjs');
const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { signToken, forgetUser } = require('../middleware/authMiddleware');
const { isPin, normalizeUsername, publicUser } = require('../utils/users');

// Wrong PINs allowed before a lockout. Each lockout in a row doubles the wait
// (15 min, 30 min, 1 h ... up to a day), so working through all 10,000 PINs isn't practical.
// Lockouts are per user: someone mistyping their PIN can't lock anyone else out.
const MAX_ATTEMPTS = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;

// Compared against when the name matches no one, so a wrong name takes as long as a wrong PIN
const UNKNOWN_USER_HASH = bcrypt.hashSync('no-such-user', 10);

const attemptsLeftText = (n) => `${n} attempt${n === 1 ? '' : 's'} left.`;

const lockedMessage = (lockUntil) => {
  const minutes = Math.max(1, Math.ceil((new Date(lockUntil) - Date.now()) / 60000));
  return `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

// The first sign-in after the upgrade to user accounts turns the old single PIN into the admin
// account (username "admin", same PIN). A brand-new database takes the admin's first PIN from
// INITIAL_PIN on the server, never from a default written in the code.
const ensureAdminUser = async () => {
  if (await User.exists({})) return;
  const config = await AppConfig.findOne().select('systemPinHash').lean();
  const pinHash = config?.systemPinHash
    || (isPin(process.env.INITIAL_PIN) ? await bcrypt.hash(process.env.INITIAL_PIN, 10) : null);
  if (!pinHash) return;
  try {
    await User.create({ name: 'Admin', username: 'admin', role: 'ADMIN', pinHash });
  } catch (error) {
    // Another sign-in created it at the same moment
    if (error.code !== 11000) throw error;
  }
};

// Checks a user's PIN under that user's lockout. Each attempt is counted atomically before the slow
// bcrypt compare, so firing many requests in parallel doesn't buy any extra guesses.
// Returns { user } when the PIN is right, otherwise { status, message } or { status: 401, attemptsLeft }.
const checkPin = async (userId, pin) => {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      active: true,
      failedAttempts: { $not: { $gte: MAX_ATTEMPTS } },
      $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date() } }],
    },
    { $inc: { failedAttempts: 1 } },
    { new: true }
  );

  if (!user) {
    const existing = await User.findById(userId).select('active lockUntil').lean();
    // A disabled account gets the same answer as a wrong PIN
    if (!existing || !existing.active) return { status: 401 };
    return { status: 429, message: lockedMessage(existing.lockUntil || Date.now()) };
  }

  if (await bcrypt.compare(pin, user.pinHash)) {
    await User.updateOne({ _id: user._id }, { $set: { failedAttempts: 0, lockCount: 0, lockUntil: null } });
    return { user };
  }

  if (user.failedAttempts >= MAX_ATTEMPTS) {
    const lockUntil = new Date(Date.now() + Math.min(BASE_LOCK_MS * 2 ** (user.lockCount || 0), MAX_LOCK_MS));
    await User.updateOne({ _id: user._id }, { $set: { failedAttempts: 0, lockUntil }, $inc: { lockCount: 1 } });
    return { status: 429, message: lockedMessage(lockUntil) };
  }

  return { status: 401, attemptsLeft: MAX_ATTEMPTS - user.failedAttempts };
};

// @desc    Sign in with a username and PIN. Without a username it signs in as the admin,
//          which is how app versions from before user accounts sign in.
// @route   POST /api/auth/login (and POST /api/auth/verify-pin)
// @access  Public (guarded by the PIN lockout)
const login = async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!isPin(pin)) {
      return res.status(400).json({ message: 'PIN must be exactly 4 digits' });
    }

    await ensureAdminUser();
    const username = normalizeUsername(req.body?.username);
    const account = username
      ? await User.findOne({ username }).select('_id').lean()
      : await User.findOne({ role: 'ADMIN', active: true }).sort({ createdAt: 1 }).select('_id').lean();

    if (!account) {
      if (!username && !(await User.exists({}))) {
        return res.status(503).json({ message: 'PIN has not been set up on the server' });
      }
      await bcrypt.compare(pin, UNKNOWN_USER_HASH);
      return res.status(401).json({ message: 'Wrong username or PIN.' });
    }

    const result = await checkPin(account._id, pin);
    if (!result.user) {
      const wrong = username ? 'Wrong username or PIN.' : 'Invalid PIN.';
      const message = result.status === 401
        ? [wrong, result.attemptsLeft ? attemptsLeftText(result.attemptsLeft) : ''].join(' ').trim()
        : result.message;
      return res.status(result.status).json({ message });
    }

    res.json({ success: true, token: signToken(result.user), user: publicUser(result.user) });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    The signed-in user
// @route   GET /api/auth/me
// @access  Private
const me = (req, res) => {
  res.json({ success: true, user: { ...req.user, active: true } });
};

// @desc    Change your own PIN and sign out your other devices
// @route   POST /api/auth/change-pin
// @access  Admin (staff PINs are set by the admin)
const changePin = async (req, res) => {
  try {
    const { oldPin, newPin } = req.body || {};
    if (!isPin(oldPin) || !isPin(newPin)) {
      return res.status(400).json({ message: 'Old and new PIN must both be exactly 4 digits' });
    }

    const result = await checkPin(req.user.id, oldPin);
    if (!result.user) {
      // 403, not 401: the caller's token is valid, only the old PIN is wrong
      if (result.status === 401) {
        const left = result.attemptsLeft ? ` ${attemptsLeftText(result.attemptsLeft)}` : '';
        return res.status(403).json({ message: `Incorrect old PIN.${left}` });
      }
      return res.status(result.status).json({ message: result.message });
    }

    const pinHash = await bcrypt.hash(newPin, 10);
    const user = await User.findByIdAndUpdate(
      result.user._id,
      { $set: { pinHash }, $inc: { tokenVersion: 1 } },
      { new: true }
    );
    forgetUser(user._id);

    // The version bump revoked every token of this user, the caller's included, so hand back a fresh one
    res.json({
      success: true,
      message: 'PIN updated. Other devices have been signed out.',
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error('Change PIN Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  login,
  me,
  changePin,
};

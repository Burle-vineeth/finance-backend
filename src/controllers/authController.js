const bcrypt = require('bcryptjs');
const AppConfig = require('../models/AppConfig');
const { signToken, rememberTokenVersion } = require('../middleware/authMiddleware');

// Wrong PINs allowed before a lockout. Each lockout in a row doubles the wait
// (15 min, 30 min, 1 h ... up to a day), so working through all 10,000 PINs isn't practical.
const MAX_ATTEMPTS = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;

const isPin = (value) => typeof value === 'string' && /^\d{4}$/.test(value);

const attemptsLeftText = (n) => `${n} attempt${n === 1 ? '' : 's'} left.`;

const lockedMessage = (lockUntil) => {
  const minutes = Math.max(1, Math.ceil((new Date(lockUntil) - Date.now()) / 60000));
  return `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

// Only a brand-new database has no config. Its first PIN comes from INITIAL_PIN on the server,
// never from a default written in the code.
const createInitialConfig = async () => {
  if (!isPin(process.env.INITIAL_PIN)) return null;
  const systemPinHash = await bcrypt.hash(process.env.INITIAL_PIN, 10);
  return AppConfig.findOneAndUpdate({}, { $setOnInsert: { systemPinHash } }, { upsert: true, new: true });
};

// Checks a PIN under a lockout shared by every client. Each attempt is counted atomically before the
// slow bcrypt compare, so firing many requests in parallel doesn't buy any extra guesses.
// Returns { config } when the PIN is right, otherwise { status, message } or { status: 401, attemptsLeft }.
const checkPin = async (pin) => {
  const config = await AppConfig.findOneAndUpdate(
    {
      failedAttempts: { $not: { $gte: MAX_ATTEMPTS } },
      $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date() } }],
    },
    { $inc: { failedAttempts: 1 } },
    { new: true }
  );

  if (!config) {
    const existing = await AppConfig.findOne().lean();
    if (existing) return { status: 429, message: lockedMessage(existing.lockUntil || Date.now()) };
    if (await createInitialConfig()) return checkPin(pin);
    return { status: 503, message: 'PIN has not been set up on the server' };
  }

  if (await bcrypt.compare(pin, config.systemPinHash)) {
    await AppConfig.updateOne({ _id: config._id }, { $set: { failedAttempts: 0, lockCount: 0, lockUntil: null } });
    rememberTokenVersion(config);
    return { config };
  }

  if (config.failedAttempts >= MAX_ATTEMPTS) {
    const lockUntil = new Date(Date.now() + Math.min(BASE_LOCK_MS * 2 ** (config.lockCount || 0), MAX_LOCK_MS));
    await AppConfig.updateOne({ _id: config._id }, { $set: { failedAttempts: 0, lockUntil }, $inc: { lockCount: 1 } });
    return { status: 429, message: lockedMessage(lockUntil) };
  }

  return { status: 401, attemptsLeft: MAX_ATTEMPTS - config.failedAttempts };
};

// @desc    Exchange the PIN for a token
// @route   POST /api/auth/verify-pin
// @access  Public (guarded by the PIN lockout)
const verifyPin = async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!isPin(pin)) {
      return res.status(400).json({ message: 'PIN must be exactly 4 digits' });
    }

    const result = await checkPin(pin);
    if (!result.config) {
      const message = result.status === 401 ? `Invalid PIN. ${attemptsLeftText(result.attemptsLeft)}` : result.message;
      return res.status(result.status).json({ message });
    }

    res.json({ success: true, token: signToken(result.config) });
  } catch (error) {
    console.error('Verify PIN Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Change the PIN and sign out every other device
// @route   POST /api/auth/change-pin
// @access  Private
const changePin = async (req, res) => {
  try {
    const { oldPin, newPin } = req.body || {};
    if (!isPin(oldPin) || !isPin(newPin)) {
      return res.status(400).json({ message: 'Old and new PIN must both be exactly 4 digits' });
    }

    const result = await checkPin(oldPin);
    if (!result.config) {
      // 403, not 401: the caller's token is valid, only the old PIN is wrong
      if (result.status === 401) {
        return res.status(403).json({ message: `Incorrect old PIN. ${attemptsLeftText(result.attemptsLeft)}` });
      }
      return res.status(result.status).json({ message: result.message });
    }

    const systemPinHash = await bcrypt.hash(newPin, 10);
    const config = await AppConfig.findByIdAndUpdate(
      result.config._id,
      { $set: { systemPinHash }, $inc: { tokenVersion: 1 } },
      { new: true }
    );
    rememberTokenVersion(config);

    // The version bump revoked every existing token, the caller's included, so hand back a fresh one
    res.json({ success: true, message: 'PIN updated. Other devices have been signed out.', token: signToken(config) });
  } catch (error) {
    console.error('Change PIN Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  verifyPin,
  changePin,
};

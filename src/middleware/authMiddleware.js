const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const TOKEN_TTL = '30d';

// Each user's role, active flag and token version are cached briefly so a request doesn't cost an
// extra DB round trip. Anything that changes them (PIN change or reset, disabling) calls forgetUser.
const USER_CACHE_MS = 30 * 1000;
const userCache = new Map();

const forgetUser = (userId) => {
  userCache.delete(String(userId));
};

const loadUser = async (userId) => {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.user;
  const user = await User.findById(userId).select('name username role active tokenVersion').lean();
  // A missing user is not cached
  if (user) userCache.set(userId, { user, at: Date.now() });
  return user;
};

const signToken = (user) => jwt.sign(
  { sub: String(user._id), role: user.role, tv: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: TOKEN_TTL }
);

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }

  try {
    // Rejects tokens of disabled users, tokens issued before the user's last PIN change or reset,
    // and tokens from before user accounts existed (they name no user)
    const user = mongoose.isValidObjectId(decoded.sub) ? await loadUser(decoded.sub) : null;
    if (!user || !user.active || decoded.tv !== (user.tokenVersion || 0)) {
      return res.status(401).json({ message: 'Not authorized, token revoked' });
    }
    // The role comes from the database, not the token, so a role change applies at once
    req.user = { id: String(user._id), name: user.name, username: user.username, role: user.role };
  } catch (error) {
    console.error('Auth Middleware Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }

  next();
};

// Lets the request through only for the given roles, e.g. requireRole('ADMIN')
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this', error: 'You do not have access to this' });
  }
  next();
};

module.exports = { authMiddleware, requireRole, signToken, forgetUser };

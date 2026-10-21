const jwt = require('jsonwebtoken');
const AppConfig = require('../models/AppConfig');

const TOKEN_TTL = '30d';

// The current config id and token version are cached briefly so a request doesn't cost an extra
// DB round trip. Changing the PIN updates the cache straight away through rememberTokenVersion.
const VERSION_CACHE_MS = 30 * 1000;
let cachedVersion = null;
let cachedAt = 0;

const rememberTokenVersion = (config) => {
  cachedVersion = config ? { configId: String(config._id), tokenVersion: config.tokenVersion || 0 } : null;
  cachedAt = Date.now();
};

const getTokenVersion = async () => {
  if (cachedVersion && Date.now() - cachedAt < VERSION_CACHE_MS) return cachedVersion;
  // A missing config is not cached, so the first login on a new database is picked up at once
  rememberTokenVersion(await AppConfig.findOne().select('tokenVersion').lean());
  return cachedVersion;
};

const signToken = (config) => jwt.sign(
  { configId: config._id, role: 'admin', tv: config.tokenVersion || 0 },
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
    // Rejects tokens issued before the last PIN change, and old tokens that carry no version
    const current = await getTokenVersion();
    if (!current || decoded.configId !== current.configId || decoded.tv !== current.tokenVersion) {
      return res.status(401).json({ message: 'Not authorized, token revoked' });
    }
  } catch (error) {
    console.error('Auth Middleware Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }

  req.user = decoded;
  next();
};

module.exports = { authMiddleware, signToken, rememberTokenVersion };

const isPin = (value) => typeof value === 'string' && /^\d{4}$/.test(value);

// Usernames are matched however they are typed: " Ravi " signs in as "ravi"
const normalizeUsername = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// What the app may see of a user: never the PIN hash or the lockout counters
const publicUser = (user) => ({
  id: String(user._id),
  name: user.name,
  username: user.username,
  role: user.role,
  active: user.active,
});

module.exports = { isPin, normalizeUsername, publicUser };

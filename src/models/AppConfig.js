const mongoose = require('mongoose');

// The single PIN that guarded the app before user accounts. Sign-in no longer reads it, except once:
// the first sign-in after the upgrade copies its PIN into the admin account (see authController).
const appConfigSchema = new mongoose.Schema(
  {
    systemPinHash: {
      type: String,
      required: true,
    },
    // PIN brute-force protection: wrong guesses since the last lockout, how many lockouts
    // in a row, and when the current lockout ends
    failedAttempts: {
      type: Number,
      default: 0,
    },
    lockCount: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    // Stamped into every token. Bumping it (on PIN change) revokes every token issued before.
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);

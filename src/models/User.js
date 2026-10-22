const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
      maxlength: [60, 'Name is too long'],
    },
    // Sign-in name, stored lowercase so it matches however it is typed
    username: {
      type: String,
      required: [true, 'Please add a username'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    role: {
      type: String,
      enum: ['ADMIN', 'STAFF'],
      required: true,
    },
    pinHash: {
      type: String,
      required: true,
    },
    // A disabled user can't sign in, and their existing tokens stop working
    active: {
      type: Boolean,
      default: true,
    },
    // Stamped into every token. Bumping it (PIN change or reset, disabling) revokes the user's earlier tokens.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    // PIN brute-force protection, per user: wrong guesses since the last lockout,
    // how many lockouts in a row, and when the current lockout ends
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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('User', userSchema);

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const { forgetUser } = require('../middleware/authMiddleware');
const { HttpError, sendError } = require('../utils/httpError');
const { isPin, normalizeUsername, publicUser } = require('../utils/users');

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

const cleanName = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60) throw new HttpError(400, 'Name must be 1 to 60 characters');
  return name;
};

// Only staff accounts are managed here; the admin changes their own PIN in Settings
const findStaff = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'User not found');
  const user = await User.findById(id).select('role').lean();
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role !== 'STAFF') throw new HttpError(403, 'Only staff accounts can be changed here');
  return user;
};

// @desc    Everyone who can sign in
// @route   GET /api/users
// @access  Admin
const listUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ role: 1, createdAt: 1 }).lean();
    res.json({ success: true, data: users.map(publicUser) });
  } catch (error) {
    sendError(res, error, 'List Users Error:');
  }
};

// @desc    Add a staff member
// @route   POST /api/users
// @access  Admin
const createStaff = async (req, res) => {
  try {
    const { pin } = req.body || {};
    const name = cleanName(req.body?.name);
    const username = normalizeUsername(req.body?.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new HttpError(400, 'Username must be 3 to 30 letters, numbers, dots, dashes or underscores');
    }
    if (!isPin(pin)) throw new HttpError(400, 'PIN must be exactly 4 digits');

    const user = await User.create({ name, username, role: 'STAFF', pinHash: await bcrypt.hash(pin, 10) });
    res.status(201).json({ success: true, data: publicUser(user) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: 'That username is already taken' });
    }
    sendError(res, error, 'Create Staff Error:');
  }
};

// @desc    Rename a staff member, or disable / enable their account. Disabling signs them out everywhere.
// @route   PATCH /api/users/:id
// @access  Admin
const updateStaff = async (req, res) => {
  try {
    await findStaff(req.params.id);
    const changes = { $set: {} };
    if (req.body?.name !== undefined) changes.$set.name = cleanName(req.body.name);
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== 'boolean') throw new HttpError(400, 'active must be true or false');
      changes.$set.active = req.body.active;
      if (!req.body.active) changes.$inc = { tokenVersion: 1 };
    }

    const user = await User.findByIdAndUpdate(req.params.id, changes, { new: true, runValidators: true });
    forgetUser(user._id);
    res.json({ success: true, data: publicUser(user) });
  } catch (error) {
    sendError(res, error, 'Update Staff Error:');
  }
};

// @desc    Give a staff member a new PIN (e.g. they forgot it). Signs them out everywhere and clears any lockout.
// @route   POST /api/users/:id/reset-pin
// @access  Admin
const resetStaffPin = async (req, res) => {
  try {
    await findStaff(req.params.id);
    const { pin } = req.body || {};
    if (!isPin(pin)) throw new HttpError(400, 'PIN must be exactly 4 digits');

    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: { pinHash: await bcrypt.hash(pin, 10), failedAttempts: 0, lockCount: 0, lockUntil: null },
        $inc: { tokenVersion: 1 },
      },
      { new: true }
    );
    forgetUser(user._id);
    res.json({ success: true, data: publicUser(user) });
  } catch (error) {
    sendError(res, error, 'Reset PIN Error:');
  }
};

module.exports = {
  listUsers,
  createStaff,
  updateStaff,
  resetStaffPin,
};

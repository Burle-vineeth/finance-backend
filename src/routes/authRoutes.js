const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AppConfig = require('../models/AppConfig');

router.post('/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ message: 'PIN is required' });
    }

    let config = await AppConfig.findOne();
    if (!config) {
      // Auto-initialize if no PIN exists (default is '1234')
      const salt = await bcrypt.genSalt(10);
      const hashedPin = await bcrypt.hash('1234', salt);
      config = await AppConfig.create({ systemPinHash: hashedPin });
    }

    const isMatch = await bcrypt.compare(pin, config.systemPinHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid PIN' });
    }

    const token = jwt.sign(
      { configId: config._id, role: 'admin' },
      process.env.JWT_SECRET || 'finance_secret_default',
      { expiresIn: '30d' }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error('Verify PIN Route Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/change-pin', async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    if (!oldPin || !newPin) {
      return res.status(400).json({ message: 'Both old PIN and new PIN are required' });
    }
    if (newPin.length !== 4) {
      return res.status(400).json({ message: 'New PIN must be exactly 4 digits' });
    }

    const config = await AppConfig.findOne();
    if (!config) {
      return res.status(500).json({ message: 'System configuration missing' });
    }

    const isMatch = await bcrypt.compare(oldPin, config.systemPinHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Incorrect old PIN' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    
    config.systemPinHash = hashedPin;
    await config.save();

    res.json({ success: true, message: 'PIN updated successfully' });
  } catch (error) {
    console.error('Change PIN Route Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

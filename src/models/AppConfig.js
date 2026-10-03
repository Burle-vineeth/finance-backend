const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema(
  {
    systemPinHash: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('AppConfig', appConfigSchema);

const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Please add a phone number'],
    },
    address: {
      type: String,
    },
    idProof: {
      type: String, // E.g., Aadhar, SSN, Passport number
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'DEFAULTER'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Client', clientSchema);

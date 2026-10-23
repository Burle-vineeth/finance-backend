const mongoose = require('mongoose');

// Runs work(session) as one MongoDB transaction: everything it writes is saved together or not at all.
// The driver re-runs work when two requests collide on the same document (e.g. two payments for one
// loan at the same moment), so each sees the other's result instead of overwriting it.
const withTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { withTransaction };

// An error that carries the HTTP status and message to send back to the app
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Sends an error as JSON: its own status for an HttpError, 400 for bad input, 500 for anything unexpected
const sendError = (res, error, label) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((val) => val.message);
    return res.status(400).json({ success: false, error: messages });
  }
  if (error.name === 'CastError') {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }
  console.error(label, error);
  return res.status(500).json({ success: false, error: 'Server Error' });
};

module.exports = { HttpError, sendError };

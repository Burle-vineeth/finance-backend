const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load env vars
dotenv.config();

// Every token is signed with JWT_SECRET, so refuse to start without a strong one
// rather than fall back to a value anyone can read in the source code
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters');
  process.exit(1);
}

// Connect to database
connectDB();

const { createApp } = require('./app');
const app = createApp();

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

// Forcing Render redeployment with a code change
// Adding a second change for PR test

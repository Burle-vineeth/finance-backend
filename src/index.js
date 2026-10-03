const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');

// Load env vars
dotenv.config();

// Connect to database
connectDB();

const app = express();

// Body parser
app.use(express.json());

// Enable CORS
app.use(cors());

// Dev logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

const { authMiddleware } = require('./middleware/authMiddleware');

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/clients', authMiddleware, require('./routes/clientRoutes'));
app.use('/api/loans', authMiddleware, require('./routes/loanRoutes'));
app.use('/api/transactions', authMiddleware, require('./routes/transactionRoutes'));
app.use('/api/dashboard', authMiddleware, require('./routes/dashboardRoutes'));

app.get('/', (req, res) => {
  res.send('Finance Backend API is running');
});

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

// Forcing Render redeployment with a code change
// Adding a second change for PR test


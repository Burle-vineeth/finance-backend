const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { authMiddleware, requireRole } = require('./middleware/authMiddleware');

// The Express app without a database connection or a listening port, so tests can drive it directly
const createApp = () => {
  const app = express();

  // Body parser
  app.use(express.json());

  // Enable CORS
  // maxAge lets browsers cache the preflight (OPTIONS) check instead of repeating it before
  // almost every API call; browsers cap it at their own maximum (e.g. 2 hours in Chrome)
  app.use(cors({ maxAge: 86400 }));

  // Dev logging middleware
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  }

  // Everything except collections is the admin's: staff can't reach it even by calling the API directly
  const adminOnly = [authMiddleware, requireRole('ADMIN')];

  app.use('/api/auth', require('./routes/authRoutes'));
  app.use('/api/collections', authMiddleware, require('./routes/collectionRoutes'));
  app.use('/api/users', adminOnly, require('./routes/userRoutes'));
  app.use('/api/clients', adminOnly, require('./routes/clientRoutes'));
  app.use('/api/loans', adminOnly, require('./routes/loanRoutes'));
  app.use('/api/transactions', adminOnly, require('./routes/transactionRoutes'));
  app.use('/api/dashboard', adminOnly, require('./routes/dashboardRoutes'));

  app.get('/', (req, res) => {
    res.send('Finance Backend API is running');
  });

  return app;
};

module.exports = { createApp };

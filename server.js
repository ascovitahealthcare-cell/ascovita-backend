'use strict';
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { sequelize } = require('./models');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.set('trust proxy', 1);
app.use(cors({
  origin: [process.env.FRONTEND_URL, 'https://www.ascovita.com', 'https://ascovita.com', /\.render\.com$/],
  credentials: true,
}));
app.use('/api',      rateLimit({ windowMs: 15*60*1000, max: 300 }));
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Too many attempts' } }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/',         (_req, res) => res.json({ status: 'Ascovita API running 🌿', ts: new Date() }));
app.get('/health',   (_req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (_req, res) => res.json({ pong: true }));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api',          require('./routes/orders'));
app.use('/api/coupons',  require('./routes/coupons'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/reviews',  require('./routes/reviews'));
app.get('/api/instagram', (_req, res) => res.json({ data: [] }));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connected');
    const { Umzug, SequelizeStorage } = require('umzug');
    const umzug = new Umzug({
      migrations: { glob: 'migrations/*.js' },
      context:    sequelize.getQueryInterface(),
      storage:    new SequelizeStorage({ sequelize }),
      logger:     console,
    });
    await umzug.up();
    console.log('✅ Migrations complete');
    app.listen(PORT, () => console.log(`🌿 Ascovita API on port ${PORT}`));
  } catch (err) {
    console.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
}
start();
module.exports = app;

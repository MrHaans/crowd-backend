// src/index.js — Production ready
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const claimRoutes  = require('./routes/claim');
const statusRoutes = require('./routes/status');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Allowed origins — tambah domain Vercel kamu setelah deploy
const ALLOWED_ORIGINS = [
  // Production
  process.env.FRONTEND_URL,                    // set di Railway env vars
  'https://the-crowd-flame.vercel.app',        // vercel domain lama
  // Development
  'http://localhost:8080',
  'http://localhost:5500',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5500',
].filter(Boolean); // buang undefined

app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Allow semua *.vercel.app untuk preview deployments
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true,
}));

app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'RATE_LIMIT', message: 'Max 60 requests per minute.' },
}));

// Routes
app.use('/api/claim',  claimRoutes);
app.use('/api/status', statusRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
});

app.listen(PORT, () => {
  console.log(`[CROWD] X-Claim backend running — port ${PORT} — env: ${process.env.NODE_ENV}`);
});

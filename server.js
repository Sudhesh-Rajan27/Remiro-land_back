require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'remiro_dev_secret_change_me';

// Request logging (must be first to track every hit)
app.use((req, res, next) => {
  console.log('Incoming request:', req.method, req.url);
  next();
});

// Middleware – order matters: cors and body parser above all routes
app.use(cors());
app.use(bodyParser.json());

// MongoDB connection
const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb+srv://sudheshrajanmn:Su%40270404@rajan-cluster.gdaj1.mongodb.net/?appName=Rajan-cluster';

mongoose
  .connect(MONGODB_URI, {
    dbName: 'remiro_auth',
  })
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
  });

// User schema & model
const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: false },
    googleId: { type: String, unique: true, sparse: true },
    picture: { type: String, trim: true },
    region: { type: String, trim: true },
    linkedin: { type: String, trim: true },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

// Waitlist schema & model (for launch seats)
const waitlistSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  },
  { timestamps: true }
);

const WaitlistEntry = mongoose.model('WaitlistEntry', waitlistSchema);

const MAX_SEATS = 150;

// In-memory list of SSE connections for seats stream
const seatClients = new Set();

async function getSeatsLeft() {
  const count = await WaitlistEntry.countDocuments({});
  const remaining = Math.max(0, MAX_SEATS - count);
  return remaining;
}

async function broadcastSeats() {
  try {
    const seatsLeft = await getSeatsLeft();
    const payload = `data: ${JSON.stringify({ seatsLeft })}\n\n`;
    for (const res of seatClients) {
      res.write(payload);
    }
  } catch (err) {
    console.error('Failed to broadcast seats:', err);
  }
}

// Helper to generate JWT
function generateToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Helper to format user for auth responses
function toAuthUser(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    email: user.email,
    region: user.region,
    linkedin: user.linkedin,
    picture: user.picture || null,
  };
}

// Google OAuth (Authorization Code Flow) – redirect_uri must match frontend and Google Console
const REDIRECT_URI = 'https://remiro.in';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
function getGoogleOAuth2Client() {
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

// Routes (order matters – specific routes first)
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Remiro backend is running' });
});

// Health check – hit this to confirm this server.js is the one running on :4000
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'Remiro backend', routes: ['/api/test', '/api/auth/google', '/api/health'] });
});

// Debug: verify server receives requests
app.get('/api/test', (req, res) => {
  res.json({ ok: true, message: 'GET /api/test hit' });
});
app.post('/api/test-post', (req, res) => {
  res.json({ ok: true, message: 'POST /api/test-post hit', body: req.body });
});

// Seats count stream (SSE)
app.get('/api/seats/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  seatClients.add(res);

  try {
    const seatsLeft = await getSeatsLeft();
    res.write(`data: ${JSON.stringify({ seatsLeft })}\n\n`);
  } catch (err) {
    console.error('Failed to send initial seats:', err);
  }

  req.on('close', () => {
    seatClients.delete(res);
    res.end();
  });
});

// Reset waitlist so seats left = 150 (dev or with secret)
app.post('/api/seats/reset', async (req, res) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const secret = req.body?.secret ?? req.query?.secret;
  const expectedSecret = process.env.SEATS_RESET_SECRET;
  if (!isDev && secret !== expectedSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await WaitlistEntry.deleteMany({});
    broadcastSeats();
    const seatsLeft = await getSeatsLeft();
    res.json({ message: 'Waitlist reset', seatsLeft });
  } catch (err) {
    console.error('Seats reset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register for early access and decrement seats
app.post('/api/register', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const existing = await WaitlistEntry.findOne({ email });
    if (existing) {
      const seatsLeft = await getSeatsLeft();
      return res.status(200).json({
        message: 'You are already registered for early access.',
        seatsLeft,
      });
    }

    const seatsLeftBefore = await getSeatsLeft();
    if (seatsLeftBefore <= 0) {
      return res.status(400).json({ error: 'No seats left', seatsLeft: 0 });
    }

    await WaitlistEntry.create({ email });
    const seatsLeft = await getSeatsLeft();

    // Notify all SSE clients
    broadcastSeats();

    res.status(201).json({
      message: 'Successfully registered for early access!',
      seatsLeft,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { fullName, email, password, region, linkedin } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName: fullName || '',
      email,
      passwordHash,
      region: region || '',
      linkedin: linkedin || '',
    });

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: toAuthUser(user),
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.passwordHash) {
      return res.status(401).json({ error: 'Use Google to sign in' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: toAuthUser(user),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Google OAuth (Authorization Code Flow): exchange code for tokens, verify id_token, upsert user
app.post('/api/auth/google', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Google OAuth is not configured' });
    }

    const oauth2Client = getGoogleOAuth2Client();
    const { tokens } = await oauth2Client.getToken({ code, redirect_uri: REDIRECT_URI });
    oauth2Client.setCredentials(tokens);

    const idToken = tokens.id_token;
    if (!idToken) {
      return res.status(400).json({ error: 'No id_token in Google response' });
    }

    const ticket = await oauth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = (payload.email || '').toLowerCase().trim();
    const name = payload.name || '';
    const picture = payload.picture || '';
    const googleId = payload.sub;

    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    let user = await User.findOne({ googleId });
    if (user) {
      // Update profile if needed
      if (user.picture !== picture || user.fullName !== name) {
        user.picture = picture;
        user.fullName = name || user.fullName;
        await user.save();
      }
    } else {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        user.picture = picture;
        if (name) user.fullName = name;
        await user.save();
      } else {
        user = await User.create({
          email,
          fullName: name,
          picture,
          googleId,
          region: '',
          linkedin: '',
        });
      }
    }

    const token = generateToken(user);
    res.json({ token, user: toAuthUser(user) });
  } catch (err) {
    console.error('Google auth error:', err);
    const googleResponse = err.response?.data;
    if (googleResponse) {
      console.error('Google API response (diagnostic):', JSON.stringify(googleResponse, null, 2));
      if (googleResponse.error === 'redirect_uri_mismatch') {
        console.error('redirect_uri_mismatch: ensure Google Console redirect URI is', REDIRECT_URI);
      }
    }
    if (err.message && err.message.includes('redirect_uri')) {
      return res.status(400).json({ error: 'Invalid redirect_uri or authorization code' });
    }
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// Example protected route
app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await User.findById(payload.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Me route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Simple endpoint to return the logged-in user's display name
app.get('/api/user/name', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await User.findById(payload.id).select('fullName email');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const name = (user.fullName && user.fullName.trim()) || (user.email && user.email.split('@')[0]) || '';
    res.json({ name });
  } catch (err) {
    console.error('User name route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler – so we return JSON and log the path (helps debug wrong server or wrong path)
app.use((req, res) => {
  console.log('404 Not Found:', req.method, req.url);
  res.status(404).json({ error: 'Not Found', method: req.method, path: req.url });
});

app.listen(PORT, () => {
  console.log(`\nRemiro backend listening on http://localhost:${PORT}`);
  console.log('  GET  /api/health  – confirm this server');
  console.log('  GET  /api/test    – debug route\n');
});


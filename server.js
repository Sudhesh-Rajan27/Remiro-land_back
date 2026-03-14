require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'remiro_dev_secret_change_me';

// Middleware
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
    passwordHash: { type: String, required: true },
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

// Routes
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Remiro backend is running' });
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
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        region: user.region,
        linkedin: user.linkedin,
      },
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

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        region: user.region,
        linkedin: user.linkedin,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


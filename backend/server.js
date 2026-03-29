const { execSync } = require('child_process');
try {
  console.log('Installing Playwright browsers...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('Browsers installed successfully.');
} catch (err) {
  console.error('Browser install failed:', err.message);
}
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');

const gstAutomation = require('./services/gstAutomation');
const sessionStore = require('./services/sessionStore');

const app = express();
const server = http.createServer(app);

// WebSocket server — for real-time OTP handoff
const wss = new WebSocket.Server({ server });

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

// File upload config — files stored in memory, never on disk
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
});

// ─── WebSocket — real-time channel per session ───────────────────────────────
wss.on('connection', (ws, req) => {
  const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
  if (!sessionId) { ws.close(); return; }
  sessionStore.attachSocket(sessionId, ws);
  console.log(`WS connected: ${sessionId}`);

  ws.on('close', () => {
    sessionStore.detachSocket(sessionId);
    console.log(`WS disconnected: ${sessionId}`);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// 1. Start a new session
app.post('/api/session/start', (req, res) => {
  const sessionId = uuidv4();
  sessionStore.create(sessionId);
  console.log(`Session started: ${sessionId}`);
  res.json({ sessionId });
});

// 2. Save collected form data
app.post('/api/session/:sessionId/data', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  sessionStore.update(sessionId, { formData: req.body });
  res.json({ ok: true });
});

// 3. Upload documents — held in memory only
app.post('/api/session/:sessionId/upload', upload.fields([
  { name: 'pan', maxCount: 1 },
  { name: 'aadhaar', maxCount: 1 },
  { name: 'addressProof', maxCount: 1 },
  { name: 'bankStatement', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
]), (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const files = {};
  Object.entries(req.files || {}).forEach(([key, arr]) => {
    files[key] = {
      buffer: arr[0].buffer,
      originalname: arr[0].originalname,
      mimetype: arr[0].mimetype,
    };
  });

  sessionStore.update(sessionId, { files: { ...session.files, ...files } });
  res.json({ ok: true, uploaded: Object.keys(files) });
});

// 4. Kick off the GST portal automation
app.post('/api/session/:sessionId/automate', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.formData) return res.status(400).json({ error: 'Form data missing' });

  // Respond immediately — automation runs async, updates via WebSocket
  res.json({ ok: true, message: 'Automation started' });

  try {
    await gstAutomation.run(sessionId, session);
  } catch (err) {
    console.error(`Automation error [${sessionId}]:`, err.message);
    sessionStore.sendToClient(sessionId, {
      type: 'error',
      message: 'Automation failed: ' + err.message,
    });
  }
});

// 5. Receive OTP from user — passed through to waiting Playwright session
app.post('/api/session/:sessionId/otp', (req, res) => {
  const { sessionId } = req.params;
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP required' });

  const resolved = sessionStore.resolveOTP(sessionId, otp);
  if (!resolved) return res.status(404).json({ error: 'No OTP request pending for this session' });

  res.json({ ok: true });
});

// 6. Clean up session after completion
app.delete('/api/session/:sessionId', (req, res) => {
  sessionStore.destroy(req.params.sessionId);
  res.json({ ok: true });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`GST Agent backend running on port ${PORT}`);
});

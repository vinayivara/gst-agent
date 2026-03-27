// In-memory session store — no database needed
// Each session holds: formData, files (buffers), websocket, OTP resolver
const sessions = new Map();

function create(sessionId) {
  sessions.set(sessionId, {
    id: sessionId,
    createdAt: Date.now(),
    formData: null,
    files: {},
    ws: null,
    otpResolver: null,
  });
}

function get(sessionId) {
  return sessions.get(sessionId) || null;
}

function update(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.set(sessionId, { ...session, ...data });
}

function destroy(sessionId) {
  const session = sessions.get(sessionId);
  if (session && session.ws) {
    try { session.ws.close(); } catch (_) {}
  }
  sessions.delete(sessionId);
  console.log(`Session destroyed: ${sessionId}`);
}

function attachSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.set(sessionId, { ...session, ws });
}

function detachSocket(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.set(sessionId, { ...session, ws: null });
}

// Send a message to the frontend chat via WebSocket
function sendToClient(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session || !session.ws) {
    console.warn(`No WS for session ${sessionId}`);
    return;
  }
  try {
    session.ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('WS send error:', err.message);
  }
}

// Called by automation when OTP screen is reached — returns a Promise
// that resolves when the user submits their OTP via the /otp endpoint
function waitForOTP(sessionId) {
  return new Promise((resolve) => {
    const session = sessions.get(sessionId);
    if (!session) { resolve(null); return; }
    sessions.set(sessionId, { ...session, otpResolver: resolve });
  });
}

// Called by the /otp POST route when user submits OTP
function resolveOTP(sessionId, otp) {
  const session = sessions.get(sessionId);
  if (!session || !session.otpResolver) return false;
  session.otpResolver(otp);
  sessions.set(sessionId, { ...session, otpResolver: null });
  return true;
}

// Auto-clean sessions older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions.entries()) {
    if (session.createdAt < cutoff) {
      destroy(id);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  create, get, update, destroy,
  attachSocket, detachSocket,
  sendToClient, waitForOTP, resolveOTP,
};

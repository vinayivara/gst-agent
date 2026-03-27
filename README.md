# GST Registration Agent

A fully automated GST registration agent. The chat collects all information,
uploads documents, controls the GST portal invisibly, and handles OTP
verification — all without you ever opening a browser.

---

## Project Structure

```
gst-agent/
├── frontend/
│   └── index.html          ← Upload this to Hostinger public_html
├── backend/
│   ├── server.js           ← Main Express + WebSocket server
│   ├── package.json
│   ├── .env.example
│   ├── services/
│   │   ├── gstAutomation.js   ← Playwright GST portal automation
│   │   └── sessionStore.js    ← In-memory session manager
│   └── utils/
│       └── fileHelper.js      ← Temp file handling
├── render.yaml             ← Render.com deployment config
└── README.md
```

---

## Deployment — Step by Step

### Step 1: GitHub (free)
1. Go to github.com and create a free account
2. Create a new repository called `gst-agent`
3. Upload all files in this project to the repository

### Step 2: Deploy Backend to Render.com (free)
1. Go to render.com and sign up with your GitHub account
2. Click "New" → "Web Service"
3. Connect your `gst-agent` GitHub repository
4. Set these settings:
   - Root Directory: `backend`
   - Build Command: `npm install && npx playwright install chromium --with-deps`
   - Start Command: `node server.js`
   - Plan: Free
5. Add environment variable:
   - Key: `FRONTEND_URL`
   - Value: `https://yourdomain.com` (your actual domain)
6. Click "Create Web Service"
7. Wait ~5 minutes for deployment
8. Copy the URL Render gives you — it looks like: `https://gst-agent-backend.onrender.com`

### Step 3: Update Frontend
1. Open `frontend/index.html`
2. Find this line near the top of the script:
   ```
   const BACKEND = 'https://your-app.onrender.com';
   ```
3. Replace `https://your-app.onrender.com` with your actual Render URL from Step 2

### Step 4: Upload Frontend to Hostinger
1. Log into your Hostinger control panel
2. Go to File Manager → public_html
3. Upload `frontend/index.html`
4. Visit yourdomain.com — your GST agent is live!

---

## How It Works

1. User opens yourdomain.com
2. Chat collects: TRN/credentials, business details, documents, verification method
3. Files uploaded directly to backend memory (never stored on disk)
4. Backend runs Playwright (headless Chrome) to fill the GST portal
5. When OTP is needed, chat asks user — user types OTP — backend submits it
6. ARN displayed in chat on successful submission
7. All sensitive data wiped from memory after session ends

---

## Security Notes

- Passwords and credentials are never written to disk or database
- All data lives in server memory for the session duration only
- Sessions auto-expire after 30 minutes
- HTTPS encrypts all data in transit
- Files (PAN, Aadhaar) are deleted immediately after upload to portal

---

## Cost Summary

| Item              | Cost              |
|-------------------|-------------------|
| Domain            | Already have it   |
| Hostinger hosting | Already have it   |
| Render.com        | Free              |
| GitHub            | Free              |
| SSL certificate   | Free              |
| **Total extra**   | **₹0/month**     |

---

## Troubleshooting

**Backend takes 30 seconds to respond on first request**
This is normal — Render free tier spins down when idle. It wakes up automatically.

**Playwright fails to find elements on GST portal**
The GST portal's HTML changes occasionally. Open a GitHub issue with the error
screenshot and the automation selectors in `gstAutomation.js` can be updated.

**OTP not being received**
Ensure the mobile number registered on the GST portal is active and receiving SMS.

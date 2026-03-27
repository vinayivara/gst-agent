const { chromium } = require('playwright');
const sessionStore = require('./sessionStore');
const { writeFileTemp, cleanupTemp } = require('../utils/fileHelper');

const GST_PORTAL = 'https://reg.gst.gov.in/registration/';
const TIMEOUT = 30000;

async function run(sessionId, session) {
  const { formData, files } = session;
  const send = (type, message, extra = {}) =>
    sessionStore.sendToClient(sessionId, { type, message, ...extra });

  send('status', 'Starting browser automation...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const tempFiles = [];

  try {
    // ── Step 1: Navigate to GST registration portal ──────────────────────────
    send('status', 'Opening GST portal...');
    await page.goto(GST_PORTAL, { waitUntil: 'networkidle', timeout: TIMEOUT });

    // ── Step 2: Choose TRN or fresh registration ──────────────────────────────
    if (formData.mode === 'TRN continuation') {
      await handleTRNFlow(page, formData, files, sessionId, send, tempFiles);
    } else {
      await handleFreshFlow(page, formData, files, sessionId, send, tempFiles);
    }

    // ── Final: Capture ARN ────────────────────────────────────────────────────
    send('status', 'Waiting for ARN confirmation...');
    await page.waitForSelector('[class*="arn"], [id*="arn"], text=/ARN/i', {
      timeout: 60000,
    });

    const arnText = await page.evaluate(() => {
      const el =
        document.querySelector('[class*="arn"]') ||
        document.querySelector('[id*="arn"]') ||
        [...document.querySelectorAll('*')].find((e) =>
          e.innerText && e.innerText.includes('ARN')
        );
      return el ? el.innerText : null;
    });

    send('complete', 'Registration submitted successfully!', { arn: arnText });
  } catch (err) {
    console.error('Automation error:', err);
    // Take screenshot for debugging
    try {
      const screenshot = await page.screenshot({ type: 'png' });
      send('error', 'An error occurred during automation: ' + err.message, {
        screenshot: screenshot.toString('base64'),
      });
    } catch (_) {
      send('error', 'An error occurred: ' + err.message);
    }
  } finally {
    await browser.close();
    cleanupTemp(tempFiles);
    // Wipe sensitive data from session
    sessionStore.update(sessionId, { files: {}, formData: null });
  }
}

// ── TRN Flow (Part B) ─────────────────────────────────────────────────────────
async function handleTRNFlow(page, formData, files, sessionId, send, tempFiles) {
  const send_ = (type, msg, extra) => sessionStore.sendToClient(sessionId, { type, message: msg, ...extra });

  // Select TRN option
  send('status', 'Selecting TRN login option...');
  await page.click('text=Temporary Reference Number (TRN)').catch(() =>
    page.click('[value="TRN"]')
  );
  await page.fill('input[name="trn"], input[placeholder*="TRN" i]', formData.trn);

  // Request OTP for TRN login
  send('status', 'Requesting OTP for TRN verification...');
  await page.click('button[type="submit"], button:has-text("Proceed")');

  // Wait for OTP screen
  await page.waitForSelector('input[name*="otp" i], input[placeholder*="otp" i]', {
    timeout: TIMEOUT,
  });

  // Ask user for OTP via chat
  send('otp_required', 'Please enter the OTP sent to your registered mobile/email to log in with your TRN.');
  const loginOtp = await sessionStore.waitForOTP(sessionId);
  if (!loginOtp) throw new Error('OTP not received from user');

  await page.fill('input[name*="otp" i], input[placeholder*="otp" i]', loginOtp);
  await page.click('button[type="submit"], button:has-text("Proceed"), button:has-text("Verify")');

  send('status', 'Logged in. Filling Part B details...');
  await page.waitForLoadState('networkidle');

  // Fill Part B form fields
  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

// ── Fresh Registration Flow (Part A + B) ─────────────────────────────────────
async function handleFreshFlow(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Starting fresh registration — filling Part A...');

  // Part A — basic details
  await page.waitForSelector('input[name*="pan" i], input[placeholder*="pan" i]');
  await page.fill('input[name*="pan" i]', formData.pan.toUpperCase());
  await page.fill('input[name*="email" i]', formData.mobileEmail.split('|')[1].trim());
  await page.fill('input[name*="mobile" i]', formData.mobileEmail.split('|')[0].trim());

  await page.click('button[type="submit"], button:has-text("Proceed")');

  // OTP for Part A
  await page.waitForSelector('input[name*="otp" i]', { timeout: TIMEOUT });
  send('otp_required', 'Please enter the OTP sent to your mobile number to verify Part A.');
  const partAOtp = await sessionStore.waitForOTP(sessionId);
  await page.fill('input[name*="otp" i]', partAOtp);
  await page.click('button:has-text("Proceed"), button:has-text("Verify")');

  send('status', 'Part A verified. Filling Part B details...');
  await page.waitForLoadState('networkidle');

  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

// ── Fill Part B (shared between both flows) ───────────────────────────────────
async function fillPartB(page, formData, files, sessionId, send, tempFiles) {
  // Business details tab
  send('status', 'Filling business details...');

  await safeFill(page, '[name*="tradeName" i], [placeholder*="trade name" i]', formData.businessName);
  await safeSelect(page, '[name*="businessType" i], [name*="constitution" i]', formData.businessType);
  await safeSelect(page, '[name*="state" i]', formData.stateOfRegistration || '');

  // Principal place of business
  send('status', 'Filling business address...');
  await safeClick(page, 'text=Principal Place of Business, a:has-text("Business Details")');
  await page.waitForLoadState('domcontentloaded');

  const addressParts = formData.businessAddress.split(',');
  await safeFill(page, '[name*="buildingName" i], [name*="address1" i]', addressParts[0] || '');
  await safeFill(page, '[name*="street" i], [name*="address2" i]', addressParts[1] || '');
  await safeFill(page, '[name*="city" i]', addressParts[2] || '');

  // Extract PIN from address
  const pinMatch = formData.businessAddress.match(/\b\d{6}\b/);
  if (pinMatch) {
    await safeFind(page, '[name*="pin" i], [name*="pincode" i]', pinMatch[0]);
  }

  // HSN/SAC codes
  send('status', 'Adding HSN/SAC codes...');
  if (formData.hsn && formData.hsn.toLowerCase() !== 'not sure') {
    await safeClick(page, 'text=Goods and Services, a:has-text("HSN")');
    await page.waitForLoadState('domcontentloaded');
    await safeFill(page, '[name*="hsn" i], [placeholder*="hsn" i]', formData.hsn);
  }

  // Bank account details
  send('status', 'Filling bank account details...');
  await safeClick(page, 'text=Bank Accounts, a:has-text("Bank")');
  await page.waitForLoadState('domcontentloaded');

  const [accountNo, ifsc] = (formData.bankAccount || '').split('|').map((s) => s.trim());
  await safeFind(page, '[name*="account" i], [placeholder*="account" i]', accountNo || '');
  await safeFind(page, '[name*="ifsc" i], [placeholder*="ifsc" i]', ifsc || '');

  // Upload documents
  send('status', 'Uploading documents...');
  await uploadDocuments(page, files, send, tempFiles);

  // Authorised signatory
  if (formData.authorisedSignatory) {
    send('status', 'Filling authorised signatory details...');
    await safeClick(page, 'text=Authorised Signatory, a:has-text("Signatory")');
    await page.waitForLoadState('domcontentloaded');
    const [sigName, sigDesig] = (formData.authorisedSignatory || '').split('|').map((s) => s.trim());
    await safeFind(page, '[name*="firstName" i], [name*="signatoryName" i]', sigName || '');
    await safeFind(page, '[name*="designation" i]', sigDesig || '');
  }

  // Verification & submission
  send('status', 'Proceeding to verification and submission...');
  await safeClick(page, 'text=Verification, a:has-text("Verification")');
  await page.waitForLoadState('domcontentloaded');

  // Select verification method
  if (formData.verificationMode && formData.verificationMode.includes('EVC')) {
    await safeClick(page, 'input[value*="EVC"], label:has-text("EVC")');
    await safeClick(page, 'button:has-text("Send OTP"), button:has-text("Generate OTP")');

    send('otp_required', 'Please enter the EVC OTP sent to your registered mobile number to submit the application.');
    const evcOtp = await sessionStore.waitForOTP(sessionId);
    await safeFind(page, 'input[name*="otp" i]', evcOtp);
    await safeClick(page, 'button:has-text("Validate"), button:has-text("Verify")');
  } else if (formData.verificationMode && formData.verificationMode.includes('e-Sign')) {
    await safeClick(page, 'input[value*="ESIGN"], label:has-text("e-Sign")');
    await safeClick(page, 'button:has-text("Proceed")');

    send('otp_required', 'Please enter the Aadhaar OTP sent to your Aadhaar-linked mobile to complete e-Sign verification.');
    const esignOtp = await sessionStore.waitForOTP(sessionId);
    await safeFind(page, 'input[name*="otp" i]', esignOtp);
    await safeClick(page, 'button:has-text("Submit"), button:has-text("Verify")');
  }

  // Final submit
  await safeClick(page, 'button:has-text("Submit"), button[type="submit"]');
  send('status', 'Application submitted! Waiting for ARN...');
}

// ── Document upload helper ────────────────────────────────────────────────────
async function uploadDocuments(page, files, send, tempFiles) {
  const docMap = {
    pan: 'PAN',
    aadhaar: 'Aadhaar',
    addressProof: 'Address Proof',
    bankStatement: 'Bank Statement',
    photo: 'Photograph',
  };

  for (const [key, label] of Object.entries(docMap)) {
    if (!files[key]) continue;
    try {
      const tmpPath = await writeFileTemp(files[key].buffer, files[key].originalname);
      tempFiles.push(tmpPath);

      // Find the upload input closest to the label
      const uploadInput = await page.$(
        `input[type="file"][name*="${key}" i], input[type="file"][id*="${key}" i]`
      );
      if (uploadInput) {
        await uploadInput.setInputFiles(tmpPath);
        send('status', `Uploaded ${label}`);
      }
    } catch (err) {
      console.warn(`Could not upload ${label}:`, err.message);
    }
  }
}

// ── Safe interaction helpers (portal DOM changes frequently) ──────────────────
async function safeClick(page, selector) {
  try {
    const el = await page.$(selector);
    if (el) await el.click();
  } catch (_) {}
}

async function safeFind(page, selector, value) {
  try {
    const el = await page.$(selector);
    if (el) { await el.clear(); await el.fill(value); }
  } catch (_) {}
}

async function safeSelect(page, selector, value) {
  try {
    const el = await page.$(selector);
    if (el) await el.selectOption({ label: value });
  } catch (_) {}
}

async function safeFind(page, selector, value) {
  try {
    await page.fill(selector, value);
  } catch (_) {}
}

module.exports = { run };

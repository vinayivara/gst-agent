const { chromium } = require('playwright');
const sessionStore = require('./sessionStore');
const { writeFileTemp, cleanupTemp } = require('../utils/fileHelper');

const GST_PORTAL = 'https://reg.gst.gov.in/registration/';
const TIMEOUT = 60000;

async function run(sessionId, session) {
  const { formData, files } = session;
  const send = (type, message, extra = {}) =>
    sessionStore.sendToClient(sessionId, { type, message, ...extra });

  send('status', 'Starting browser automation...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const tempFiles = [];

  try {
    send('status', 'Opening GST portal...');
    await page.goto(GST_PORTAL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    if (formData.mode === 'TRN continuation') {
      await handleTRNFlow(page, formData, files, sessionId, send, tempFiles);
    } else {
      await handleFreshFlow(page, formData, files, sessionId, send, tempFiles);
    }

  } catch (err) {
    console.error('Automation error:', err);
    const screenshot = await page.screenshot({ type: 'png' }).catch(() => null);
    send('error', 'An error occurred: ' + err.message, {
      screenshot: screenshot ? screenshot.toString('base64') : null,
    });
  } finally {
    await browser.close();
    cleanupTemp(tempFiles);
    sessionStore.update(sessionId, { files: {}, formData: null });
  }
}

async function handleTRNFlow(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Selecting TRN option on GST portal...');

  // Click TRN radio button — try multiple selectors
  await page.evaluate(() => {
    const labels = document.querySelectorAll('label, span, div');
    for (const el of labels) {
      if (el.innerText && el.innerText.includes('TRN')) {
        el.click(); return;
      }
    }
  });
  await page.waitForTimeout(2000);

  // Fill TRN field
  send('status', 'Entering TRN number...');
  const trnInput = await page.$('input[id*="trn" i], input[name*="trn" i], input[placeholder*="trn" i], input[type="text"]');
  if (trnInput) {
    await trnInput.click();
    await trnInput.fill(formData.trn);
  }

  // Click proceed/submit button
  await clickButton(page, ['Proceed', 'Submit', 'Continue', 'Next']);
  await page.waitForTimeout(3000);

  // Wait for OTP input — broad selector
  send('status', 'Waiting for OTP screen...');
  await page.waitForSelector('input', { timeout: TIMEOUT });

  // Ask user for OTP
  send('otp_required', 'Please enter the OTP sent to your registered mobile/email to log in with your TRN.');
  const loginOtp = await sessionStore.waitForOTP(sessionId);
  if (!loginOtp) throw new Error('OTP not received');

  // Fill OTP — find the visible input
  const otpInput = await findVisibleInput(page);
  if (otpInput) {
    await otpInput.fill(loginOtp);
  }

  await clickButton(page, ['Proceed', 'Verify', 'Submit', 'Validate']);
  await page.waitForTimeout(3000);

  send('status', 'Logged in successfully. Loading Part B form...');
  await page.waitForLoadState('domcontentloaded');

  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

async function handleFreshFlow(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Starting fresh registration — filling Part A...');
  await page.waitForSelector('input', { timeout: TIMEOUT });
  await page.waitForTimeout(2000);

  // Fill PAN
  const panInput = await page.$('input[id*="pan" i], input[name*="pan" i], input[placeholder*="pan" i]');
  if (panInput) await panInput.fill(formData.pan.toUpperCase());

  // Fill email and mobile
  const emailInput = await page.$('input[type="email"], input[id*="email" i], input[name*="email" i]');
  if (emailInput) await emailInput.fill(formData.mobileEmail.split('|')[1].trim());

  const mobileInput = await page.$('input[type="tel"], input[id*="mobile" i], input[name*="mobile" i]');
  if (mobileInput) await mobileInput.fill(formData.mobileEmail.split('|')[0].trim());

  await clickButton(page, ['Proceed', 'Submit', 'Continue']);
  await page.waitForTimeout(3000);

  send('otp_required', 'Please enter the OTP sent to your mobile to verify Part A.');
  const partAOtp = await sessionStore.waitForOTP(sessionId);
  const otpInput = await findVisibleInput(page);
  if (otpInput) await otpInput.fill(partAOtp);

  await clickButton(page, ['Proceed', 'Verify', 'Submit']);
  await page.waitForTimeout(3000);

  send('status', 'Part A verified. Loading Part B...');
  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

async function fillPartB(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Filling business details...');
  await page.waitForTimeout(2000);

  // Trade name
  const nameInput = await page.$('input[id*="trade" i], input[name*="trade" i], input[placeholder*="trade" i], input[id*="business" i]');
  if (nameInput) await nameInput.fill(formData.businessName);

  // Address
  send('status', 'Filling address details...');
  const addressParts = formData.businessAddress.split(',');
  const addr1 = await page.$('input[id*="addr1" i], input[id*="address1" i], input[name*="addr" i]');
  if (addr1) await addr1.fill(addressParts[0] || '');

  const pinMatch = formData.businessAddress.match(/\b\d{6}\b/);
  if (pinMatch) {
    const pinInput = await page.$('input[id*="pin" i], input[name*="pin" i], input[placeholder*="pin" i]');
    if (pinInput) await pinInput.fill(pinMatch[0]);
  }

  // Bank details
  send('status', 'Filling bank account details...');
  const [accountNo, ifsc] = (formData.bankAccount || '').split('|').map(s => s.trim());
  const accInput = await page.$('input[id*="account" i], input[name*="account" i]');
  if (accInput) await accInput.fill(accountNo || '');
  const ifscInput = await page.$('input[id*="ifsc" i], input[name*="ifsc" i]');
  if (ifscInput) await ifscInput.fill(ifsc || '');

  // Upload documents
  send('status', 'Uploading documents...');
  await uploadDocuments(page, files, send, tempFiles);

  // Verification
  send('status', 'Proceeding to verification...');
  await page.waitForTimeout(2000);

  if (formData.verificationMode && formData.verificationMode.includes('EVC')) {
    const evcRadio = await page.$('input[value*="EVC" i], input[id*="evc" i]');
    if (evcRadio) await evcRadio.click();
    await clickButton(page, ['Send OTP', 'Generate OTP', 'Get OTP']);
    await page.waitForTimeout(3000);

    send('otp_required', 'Please enter the EVC OTP sent to your registered mobile to submit the application.');
    const evcOtp = await sessionStore.waitForOTP(sessionId);
    const otpInput = await findVisibleInput(page);
    if (otpInput) await otpInput.fill(evcOtp);
    await clickButton(page, ['Validate', 'Verify', 'Submit']);
  }

  await clickButton(page, ['Submit', 'Final Submit']);
  send('status', 'Application submitted! Waiting for ARN...');
  await page.waitForTimeout(5000);

  // Grab ARN from page
  const arn = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && el.innerText && el.innerText.match(/ARN\d+|[A-Z]{2}\d{2}[A-Z0-9]{10}/)) {
        return el.innerText.trim();
      }
    }
    return null;
  });

  sessionStore.sendToClient(sessionId, { type: 'complete', message: 'Done!', arn });
}

async function uploadDocuments(page, files, send, tempFiles) {
  const docMap = { pan: 'PAN', aadhaar: 'Aadhaar', addressProof: 'Address Proof', bankStatement: 'Bank Statement', photo: 'Photo' };
  for (const [key, label] of Object.entries(docMap)) {
    if (!files[key]) continue;
    try {
      const { writeFileTemp } = require('../utils/fileHelper');
      const tmpPath = await writeFileTemp(files[key].buffer, files[key].originalname);
      tempFiles.push(tmpPath);
      const input = await page.$(`input[type="file"][name*="${key}" i], input[type="file"][id*="${key}" i], input[type="file"]`);
      if (input) { await input.setInputFiles(tmpPath); send('status', `Uploaded ${label}`); }
    } catch (err) { console.warn(`Could not upload ${label}:`, err.message); }
  }
}

// Find the most visible text input on the page
async function findVisibleInput(page) {
  return page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input:not([type])');
    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return input;
    }
    return null;
  });
}

// Click a button by trying multiple label texts
async function clickButton(page, labels) {
  for (const label of labels) {
    try {
      const btn = await page.$(`button:has-text("${label}"), input[value="${label}"], a:has-text("${label}")`);
      if (btn) { await btn.click(); return; }
    } catch (_) {}
  }
}

module.exports = { run };

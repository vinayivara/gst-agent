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

    // ── Handle CAPTCHA on landing page if present ──────────────────────────
    await handleCaptchaIfPresent(page, sessionId, send);

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

// ── Detect and handle CAPTCHA anywhere in the flow ───────────────────────────
async function handleCaptchaIfPresent(page, sessionId, send) {
  try {
    // Check if a CAPTCHA image exists on the page
    const captchaImg = await page.$('img[src*="captcha" i], img[id*="captcha" i], img[class*="captcha" i], #captchaImage, .captcha img');
    if (!captchaImg) return; // No CAPTCHA found

    send('status', 'CAPTCHA detected — sending to chat...');

    // Screenshot just the CAPTCHA image
    const captchaBox = await captchaImg.boundingBox();
    let captchaBase64;

    if (captchaBox) {
      const captchaScreenshot = await page.screenshot({
        type: 'png',
        clip: {
          x: Math.max(0, captchaBox.x - 10),
          y: Math.max(0, captchaBox.y - 10),
          width: captchaBox.width + 20,
          height: captchaBox.height + 20,
        },
      });
      captchaBase64 = captchaScreenshot.toString('base64');
    } else {
      // Fallback — full page screenshot
      const fullScreenshot = await page.screenshot({ type: 'png' });
      captchaBase64 = fullScreenshot.toString('base64');
    }

    // Send CAPTCHA image to chat and wait for user input
    send('captcha_required', 'Please enter the CAPTCHA shown in the image below.', {
      screenshot: captchaBase64,
    });

    const captchaValue = await sessionStore.waitForOTP(sessionId); // reuse OTP wait mechanism
    if (!captchaValue) throw new Error('CAPTCHA not received from user');

    // Fill CAPTCHA input field
    const captchaInput = await page.$(
      'input[id*="captcha" i], input[name*="captcha" i], input[placeholder*="captcha" i], input[class*="captcha" i]'
    );
    if (captchaInput) {
      await captchaInput.fill(captchaValue);
      send('status', 'CAPTCHA entered. Proceeding...');
    } else {
      // Fallback — find first visible text input
      const visibleInput = await findVisibleInput(page);
      const visibleEl = visibleInput.asElement();
      if (visibleEl) await visibleEl.fill(captchaValue);
    }

    // Submit CAPTCHA
    await clickButton(page, ['Submit', 'Proceed', 'Continue', 'Login', 'Go']);
    await page.waitForTimeout(2000);

    // Check if CAPTCHA is still present (wrong entry)
    const stillPresent = await page.$('img[src*="captcha" i], img[id*="captcha" i]');
    if (stillPresent) {
      send('status', 'CAPTCHA was incorrect — trying again...');
      await handleCaptchaIfPresent(page, sessionId, send); // Retry recursively
    }

  } catch (err) {
    // No CAPTCHA or error handling — continue
    console.log('CAPTCHA check:', err.message);
  }
}

// ── TRN Flow ──────────────────────────────────────────────────────────────────
async function handleTRNFlow(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Selecting TRN option on GST portal...');

  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="radio"]');
    for (const input of inputs) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      const labelText = label ? label.innerText : '';
      const parentText = input.parentElement ? input.parentElement.innerText : '';
      if (labelText.includes('TRN') || parentText.includes('TRN')) {
        input.click(); return;
      }
    }
    const allEls = document.querySelectorAll('label, span, a, button');
    for (const el of allEls) {
      if (el.innerText && el.innerText.trim() === 'TRN') {
        el.click(); return;
      }
    }
  });
  await page.waitForTimeout(2000);

  // Handle CAPTCHA after selecting TRN if it appears
  await handleCaptchaIfPresent(page, sessionId, send);

  // Fill TRN number
  send('status', 'Entering TRN number...');
  const trnInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      if (id.includes('trn') || name.includes('trn') || placeholder.includes('trn')) return input;
    }
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const rect = input.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return input;
    }
    return null;
  });

  const trnEl = trnInput.asElement();
  if (trnEl) {
    await trnEl.click();
    await trnEl.fill(formData.trn);
  }

  await clickButton(page, ['Proceed', 'Submit', 'Continue', 'Next']);
  await page.waitForTimeout(3000);

  // Handle CAPTCHA after submitting TRN
  await handleCaptchaIfPresent(page, sessionId, send);

  send('status', 'Waiting for OTP screen...');
  await page.waitForTimeout(2000);

  send('otp_required', 'Please enter the OTP sent to your registered mobile/email to log in with your TRN.');
  const loginOtp = await sessionStore.waitForOTP(sessionId);
  if (!loginOtp) throw new Error('OTP not received from user');

  const otpInput = await findVisibleInput(page);
  const otpEl = otpInput.asElement();
  if (otpEl) await otpEl.fill(loginOtp);

  await clickButton(page, ['Proceed', 'Verify', 'Submit', 'Validate']);
  await page.waitForTimeout(3000);

  // Handle CAPTCHA after OTP if present
  await handleCaptchaIfPresent(page, sessionId, send);

  send('status', 'Logged in. Loading Part B form...');
  await page.waitForLoadState('domcontentloaded');
  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

// ── Fresh Registration Flow ───────────────────────────────────────────────────
async function handleFreshFlow(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Starting fresh registration — filling Part A...');
  await page.waitForTimeout(2000);

  await handleCaptchaIfPresent(page, sessionId, send);

  const panInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      if (id.includes('pan') || name.includes('pan') || placeholder.includes('pan')) return input;
    }
    return null;
  });
  const panEl = panInput.asElement();
  if (panEl) await panEl.fill(formData.pan.toUpperCase());

  const emailInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'email') return input;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (id.includes('email') || name.includes('email')) return input;
    }
    return null;
  });
  const emailEl = emailInput.asElement();
  if (emailEl) await emailEl.fill(formData.mobileEmail.split('|')[1].trim());

  const mobileInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'tel') return input;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (id.includes('mobile') || name.includes('mobile') || id.includes('phone') || name.includes('phone')) return input;
    }
    return null;
  });
  const mobileEl = mobileInput.asElement();
  if (mobileEl) await mobileEl.fill(formData.mobileEmail.split('|')[0].trim());

  await clickButton(page, ['Proceed', 'Submit', 'Continue']);
  await page.waitForTimeout(3000);

  await handleCaptchaIfPresent(page, sessionId, send);

  send('otp_required', 'Please enter the OTP sent to your mobile to verify Part A.');
  const partAOtp = await sessionStore.waitForOTP(sessionId);
  const otpInput = await findVisibleInput(page);
  const otpEl = otpInput.asElement();
  if (otpEl) await otpEl.fill(partAOtp);

  await clickButton(page, ['Proceed', 'Verify', 'Submit']);
  await page.waitForTimeout(3000);

  send('status', 'Part A verified. Loading Part B...');
  await fillPartB(page, formData, files, sessionId, send, tempFiles);
}

// ── Fill Part B ───────────────────────────────────────────────────────────────
async function fillPartB(page, formData, files, sessionId, send, tempFiles) {
  send('status', 'Filling business details...');
  await page.waitForTimeout(2000);

  await handleCaptchaIfPresent(page, sessionId, send);

  const nameInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      if (id.includes('trade') || name.includes('trade') || placeholder.includes('trade') ||
          id.includes('business') || name.includes('business')) return input;
    }
    return null;
  });
  const nameEl = nameInput.asElement();
  if (nameEl) await nameEl.fill(formData.businessName);

  send('status', 'Filling address details...');
  const addressParts = formData.businessAddress.split(',');

  const addr1Input = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (id.includes('addr') || name.includes('addr') || id.includes('building') || name.includes('building')) return input;
    }
    return null;
  });
  const addr1El = addr1Input.asElement();
  if (addr1El) await addr1El.fill(addressParts[0] ? addressParts[0].trim() : '');

  const pinMatch = formData.businessAddress.match(/\b\d{6}\b/);
  if (pinMatch) {
    const pinInput = await page.evaluateHandle(() => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const type = input.type.toLowerCase();
        if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
        const id = (input.id || '').toLowerCase();
        const name = (input.name || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();
        if (id.includes('pin') || name.includes('pin') || placeholder.includes('pin') ||
            id.includes('zip') || name.includes('zip')) return input;
      }
      return null;
    });
    const pinEl = pinInput.asElement();
    if (pinEl) await pinEl.fill(pinMatch[0]);
  }

  send('status', 'Filling bank account details...');
  const [accountNo, ifsc] = (formData.bankAccount || '').split('|').map(s => s.trim());

  const accInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (id.includes('account') || name.includes('account') || id.includes('accno') || name.includes('accno')) return input;
    }
    return null;
  });
  const accEl = accInput.asElement();
  if (accEl) await accEl.fill(accountNo || '');

  const ifscInput = await page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' || type === 'button' || type === 'hidden') continue;
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (id.includes('ifsc') || name.includes('ifsc')) return input;
    }
    return null;
  });
  const ifscEl = ifscInput.asElement();
  if (ifscEl) await ifscEl.fill(ifsc || '');

  send('status', 'Uploading documents...');
  await uploadDocuments(page, files, send, tempFiles);

  send('status', 'Proceeding to verification...');
  await page.waitForTimeout(2000);

  await handleCaptchaIfPresent(page, sessionId, send);

  if (formData.verificationMode && formData.verificationMode.includes('EVC')) {
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="radio"]');
      for (const input of inputs) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        const labelText = label ? label.innerText : '';
        const parentText = input.parentElement ? input.parentElement.innerText : '';
        if (labelText.includes('EVC') || parentText.includes('EVC') ||
            (input.value && input.value.toUpperCase().includes('EVC'))) {
          input.click(); return;
        }
      }
    });
    await page.waitForTimeout(1000);
    await clickButton(page, ['Send OTP', 'Generate OTP', 'Get OTP']);
    await page.waitForTimeout(3000);

    await handleCaptchaIfPresent(page, sessionId, send);

    send('otp_required', 'Please enter the EVC OTP sent to your registered mobile to submit the application.');
    const evcOtp = await sessionStore.waitForOTP(sessionId);
    const evcInput = await findVisibleInput(page);
    const evcEl = evcInput.asElement();
    if (evcEl) await evcEl.fill(evcOtp);

    await clickButton(page, ['Validate', 'Verify', 'Submit']);
    await page.waitForTimeout(3000);

  } else if (formData.verificationMode && formData.verificationMode.includes('e-Sign')) {
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="radio"]');
      for (const input of inputs) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        const labelText = label ? label.innerText : '';
        if (labelText.includes('e-Sign') || labelText.includes('eSign') ||
            (input.value && input.value.toLowerCase().includes('esign'))) {
          input.click(); return;
        }
      }
    });
    await page.waitForTimeout(1000);
    await clickButton(page, ['Proceed', 'Submit']);
    await page.waitForTimeout(3000);

    send('otp_required', 'Please enter the Aadhaar OTP sent to your Aadhaar-linked mobile for e-Sign verification.');
    const esignOtp = await sessionStore.waitForOTP(sessionId);
    const esignInput = await findVisibleInput(page);
    const esignEl = esignInput.asElement();
    if (esignEl) await esignEl.fill(esignOtp);

    await clickButton(page, ['Submit', 'Verify', 'Validate']);
    await page.waitForTimeout(3000);
  }

  await clickButton(page, ['Submit', 'Final Submit', 'Proceed']);
  send('status', 'Application submitted! Waiting for ARN...');
  await page.waitForTimeout(5000);

  const arn = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && el.innerText) {
        const text = el.innerText.trim();
        if (text.match(/ARN\s*[-:]?\s*[A-Z0-9]{15,}/i) || text.match(/^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/)) {
          return text;
        }
      }
    }
    const body = document.body.innerText;
    const match = body.match(/ARN[\s:-]*([A-Z0-9]{15,})/i);
    return match ? match[0] : 'ARN generated — check your registered email/mobile for confirmation.';
  });

  sessionStore.sendToClient(sessionId, { type: 'complete', message: 'Registration submitted successfully!', arn });
}

// ── Upload documents ──────────────────────────────────────────────────────────
async function uploadDocuments(page, files, send, tempFiles) {
  const docMap = {
    pan: 'PAN',
    aadhaar: 'Aadhaar',
    addressProof: 'Address Proof',
    bankStatement: 'Bank Statement',
    photo: 'Photo',
  };
  for (const [key, label] of Object.entries(docMap)) {
    if (!files[key]) continue;
    try {
      const tmpPath = await writeFileTemp(files[key].buffer, files[key].originalname);
      tempFiles.push(tmpPath);
      const input = await page.$(`input[type="file"][name*="${key}" i], input[type="file"][id*="${key}" i]`);
      if (input) {
        await input.setInputFiles(tmpPath);
        send('status', `Uploaded ${label}`);
        await page.waitForTimeout(1000);
      }
    } catch (err) {
      console.warn(`Could not upload ${label}:`, err.message);
    }
  }
}

// ── Find first visible non-radio input ───────────────────────────────────────
async function findVisibleInput(page) {
  return page.evaluateHandle(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'submit' ||
          type === 'button' || type === 'hidden' || type === 'file') continue;
      const rect = input.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return input;
    }
    return null;
  });
}

// ── Click button by label ─────────────────────────────────────────────────────
async function clickButton(page, labels) {
  for (const label of labels) {
    try {
      const btn = await page.$(`button:has-text("${label}"), input[value="${label}"], a:has-text("${label}")`);
      if (btn) { await btn.click(); return; }
    } catch (_) {}
  }
  await page.evaluate((labels) => {
    const buttons = document.querySelectorAll('button, input[type="submit"], a');
    for (const btn of buttons) {
      const text = btn.innerText || btn.value || '';
      for (const label of labels) {
        if (text.trim().toLowerCase().includes(label.toLowerCase())) {
          btn.click(); return;
        }
      }
    }
  }, labels);
}

module.exports = { run };

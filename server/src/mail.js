/**
 * Spendo - sending the sign-in code
 *
 * Brevo's HTTP API rather than SMTP. That is not a preference: most managed hosts
 * (Render among them) block outbound connections on 25, 465 and 587, so anything
 * speaking SMTP from inside the service hangs until it times out. This is ordinary
 * HTTPS on 443.
 *
 * Deliverability is the weakest link in a code-by-email login - a code that lands in
 * spam is a broken sign-in. Hence the plain text part alongside the HTML, the boring
 * subject, and one consistent verified sender.
 *
 * This is the only outbound request the server makes, and it is server-side. The
 * client's rule that no runtime request leaves our own origin is untouched.
 */

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const CODE_TTL_MINUTES = 10;

const apiKey = () => process.env.BREVO_API_KEY || '';
const fromEmail = () => process.env.MAIL_FROM_EMAIL || '';
const fromName = () => process.env.MAIL_FROM_NAME || 'Spendo';

export function mailConfigured() {
  return Boolean(apiKey() && fromEmail());
}

function body(code) {
  return {
    text:
      `Your Spendo sign-in code is ${code}\n\n` +
      `It expires in ${CODE_TTL_MINUTES} minutes. If you did not ask for it, ignore this email.\n`,
    html:
      '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#161a17">' +
      '<p>Your Spendo sign-in code is</p>' +
      '<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;' +
      `font-weight:700;letter-spacing:5px;margin:18px 0">${code}</p>` +
      `<p style="color:#4c524c">It expires in ${CODE_TTL_MINUTES} minutes. ` +
      'If you did not ask for it, ignore this email.</p>' +
      '</div>'
  };
}

/**
 * Send one code.
 *
 * Resolves to a result rather than throwing: a mail failure must not take the
 * request down, because the caller has to report it in a way the person can act on
 * ("try again in a moment"), and they can simply ask for another code.
 */
export async function sendLoginCode(to, code) {
  if (!mailConfigured()) {
    // Without a key, printing the code is far more useful than failing: sign-in can
    // be tested end to end before the sender is verified. Unreachable in production,
    // where the key is checked before these routes are mounted.
    console.log(`[mail] not configured - sign-in code for ${to} is ${code}`);
    return { ok: true, simulated: true };
  }

  const parts = body(code);

  try {
    const response = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey(),
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: fromEmail(), name: fromName() },
        to: [{ email: to }],
        // The code is in the body, never the subject. A subject line is shown on a
        // lock screen, sits in a notification, and is the part most likely to be
        // logged in plain text by every mail server it passes through.
        subject: 'Your Spendo sign-in code',
        textContent: parts.text,
        htmlContent: parts.html
      })
    });

    if (response.ok) return { ok: true };

    // Brevo explains refusals in the body, and the usual one is worth naming in the
    // log: a sender address that has not been verified on the account.
    const detail = await response.text();
    console.error('[mail] brevo refused:', response.status, detail.slice(0, 300));
    return { ok: false, status: response.status };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return { ok: false, status: 0 };
  }
}

export { CODE_TTL_MINUTES };

// Postmark sender. The Postmark server API token reaches us through env as
// `postmarkServerToken`: hereya auto-resolves the SSM SecureString that the
// `hereya/postmark-app-server` package creates, so by the time this code
// runs the env var holds the actual token (not an ARN). Same in Lambda and
// in `hereya run` locally — no per-cold-start SSM round-trip needed.

function getToken(): string {
  const token = process.env.postmarkServerToken;
  if (!token) {
    throw new Error(
      'postmarkServerToken env var is missing (provisioned by hereya/postmark-app-server)',
    );
  }
  return token;
}

export async function sendOtp(toEmail: string, otp: string): Promise<void> {
  const token = getToken();
  const from = process.env.postmarkFromEmail;
  if (!from) throw new Error('postmarkFromEmail env var missing');
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: toEmail,
      Subject: 'Your code',
      TextBody: 'Your OTP code is: ' + otp,
      MessageStream: 'outbound',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Postmark send failed: ${res.status} ${text}`);
  }
}

// Shared WebAuthn registration flow. Used by both:
//   • the Passkeys settings card (full management UI)
//   • the no-passkey banner shown on post-login dashboards
//
// Keeping the three-step roundtrip in one place means we can't drift
// (e.g. forget to forward `deviceLabel`, or change the API shape on one
// caller).
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';

export type RegisterPasskeyResult =
  | { status: 'ok' }
  | { status: 'cancelled' }; // user dismissed the OS prompt

/**
 * Run the WebAuthn registration roundtrip end-to-end.
 *
 * On `cancelled`, the user dismissed the OS prompt — no error to surface.
 * Any other failure (network, server, OS error) throws so the caller can
 * render a friendly message via `friendlyError`.
 */
export async function registerPasskey(
  deviceLabel: string,
): Promise<RegisterPasskeyResult> {
  const { challengeId, options } = await api<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>('/api/webauthn/register/options', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAllowedError') {
      return { status: 'cancelled' };
    }
    throw err;
  }

  await api('/api/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, deviceLabel, response }),
  });

  return { status: 'ok' };
}

// Pick a reasonable default label so most users don't have to rename anything.
export function defaultDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return 'This device';
}

// Shared fingerprint icon — used by the login button, the settings card,
// and the post-login banner so the visual language is consistent.
export const PASSKEY_ICON_PATHS = [
  'M12 11c0 7-5 9-5 9',
  'M16 22c0 0 5-3 5-10A9 9 0 0 0 7 4.6',
  'M3.1 9a9 9 0 0 1 4-4.4',
  'M4 22c1.4-2 2-4.5 2-7v-1a6 6 0 0 1 12 0v.6',
  'M14 13c.5 5-2 8-3.5 9.5',
  'M9 6.8a6 6 0 0 1 9 5.2',
] as const;

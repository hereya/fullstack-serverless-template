import crypto from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  UsernameExistsException,
  type InitiateAuthCommandOutput,
  type RespondToAuthChallengeCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';

let _client: CognitoIdentityProviderClient | null = null;

export function getCognito(): CognitoIdentityProviderClient {
  if (!_client) {
    _client = new CognitoIdentityProviderClient({ region: process.env.awsCognitoRegion });
  }
  return _client;
}

/** For tests. */
export function _setCognito(client: CognitoIdentityProviderClient): void {
  _client = client;
}

/**
 * Ensures the Cognito user exists. Idempotent — catches UsernameExistsException
 * (documented pattern from aws-cognito/README.md).
 */
export async function ensureUser(email: string): Promise<void> {
  const ClientId = process.env.userPoolClientId!;
  try {
    await getCognito().send(
      new SignUpCommand({
        ClientId,
        Username: email,
        Password: crypto.randomUUID() + 'Aa1!', // required by API; never used
        UserAttributes: [{ Name: 'email', Value: email }],
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) return; // returning user
    throw err;
  }
}

/**
 * Starts the CUSTOM_AUTH flow. Returns the OTP (read from ChallengeParameters)
 * AND the opaque Session. The OTP must be sent via email; ONLY the session is
 * exposed to the browser.
 */
export async function startCustomAuth(email: string): Promise<{ session: string; otp: string }> {
  const ClientId = process.env.userPoolClientId!;
  const response: InitiateAuthCommandOutput = await getCognito().send(
    new InitiateAuthCommand({
      AuthFlow: 'CUSTOM_AUTH',
      ClientId,
      AuthParameters: { USERNAME: email },
    }),
  );
  const session = response.Session;
  const otp = response.ChallengeParameters?.otp;
  if (!session || !otp) {
    throw new Error('Cognito did not return a session or OTP');
  }
  return { session, otp };
}

export async function respondToCustomChallenge(
  email: string,
  session: string,
  code: string,
): Promise<RespondToAuthChallengeCommandOutput> {
  const ClientId = process.env.userPoolClientId!;
  return getCognito().send(
    new RespondToAuthChallengeCommand({
      ClientId,
      ChallengeName: 'CUSTOM_CHALLENGE',
      Session: session,
      ChallengeResponses: { USERNAME: email, ANSWER: code },
    }),
  );
}

export async function refreshTokens(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const ClientId = process.env.userPoolClientId!;
  const res = await getCognito().send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );
  const accessToken = res.AuthenticationResult?.AccessToken;
  const expiresIn = res.AuthenticationResult?.ExpiresIn ?? 3600;
  if (!accessToken) throw new Error('Refresh failed: no access token returned');
  return { accessToken, expiresIn };
}

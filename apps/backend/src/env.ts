import { z } from 'zod';

// hereya/dev-iam-user and aws/cognito both inject region-related vars as camelCase.
// AWS SDK reads AWS_REGION / AWS_DEFAULT_REGION (uppercase). Bridge them here.
process.env.AWS_REGION ||= process.env.awsRegion ?? process.env.awsCognitoRegion;

const schema = z.object({
  // aws/cognito
  userPoolId: z.string().min(1),
  userPoolClientId: z.string().min(1),
  awsCognitoRegion: z.string().min(1),
  sessionsTableName: z.string().min(1),
  authUsersTableName: z.string().min(1),
  authRolesTableName: z.string().min(1),
  // hereya/aws-ddb-app-state
  registrationsTableName: z.string().min(1),
  oauthStateTableName: z.string().min(1),
  // hereya/postmark-app-server — hereya auto-resolves the SSM SecureString
  // behind the scenes, so this env var holds the actual Postmark token.
  postmarkServerToken: z.string().min(1),
  postmarkFromEmail: z.string().email(),
  // hereya/aws-app-lambda (for cookie / logging)
  domain: z.string().min(1).optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function loadEnv(): z.infer<typeof schema> {
  if (cached) return cached;
  cached = schema.parse({
    userPoolId: process.env.userPoolId,
    userPoolClientId: process.env.userPoolClientId,
    awsCognitoRegion: process.env.awsCognitoRegion,
    sessionsTableName: process.env.sessionsTableName,
    authUsersTableName: process.env.authUsersTableName,
    authRolesTableName: process.env.authRolesTableName,
    registrationsTableName: process.env.registrationsTableName,
    oauthStateTableName: process.env.oauthStateTableName,
    postmarkServerToken: process.env.postmarkServerToken,
    postmarkFromEmail: process.env.postmarkFromEmail,
    domain: process.env.domain,
  });
  return cached;
}

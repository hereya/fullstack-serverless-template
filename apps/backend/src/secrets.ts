import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let resolved = false;

export async function resolveSecrets(): Promise<void> {
  if (resolved) return;
  const arn = process.env.HEREYA_SECRETS_ARN;
  if (!arn) {
    resolved = true;
    return;
  }
  const client = new SecretsManagerClient({});
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (SecretString) {
    for (const [k, v] of Object.entries(JSON.parse(SecretString) as Record<string, string>)) {
      process.env[k] = v;
    }
  }
  resolved = true;
}

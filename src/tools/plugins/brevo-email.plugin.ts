import { sendBrevoEmail } from '../brevo-email';

export async function run(input: unknown): Promise<string> {
  const result = await sendBrevoEmail(input);
  return result.content;
}

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const EMAIL_LOCAL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_{|}~-]+$/;

function isValidDomain(domain: string): boolean {
  if (domain.length > 253) {
    return false;
  }
  return domain.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      DNS_LABEL_PATTERN.test(label),
  );
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (
    at <= 0 ||
    at !== normalized.indexOf('@') ||
    !EMAIL_LOCAL_PATTERN.test(normalized.slice(0, at)) ||
    !isValidDomain(normalized.slice(at + 1))
  ) {
    return null;
  }
  return normalized;
}

export function isAllowedAdminEmail(
  email: string | null | undefined,
): email is string {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  if (process.env.DEMO_AUTH_ENABLED === 'true' && normalized === 'demo@example.test') return true;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  const allowedDomains = new Set(
    (process.env.GOOGLE_ALLOWED_DOMAINS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowedDomains.has(domain);
}

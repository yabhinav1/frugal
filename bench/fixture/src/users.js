// Validation and normalisation of user-supplied account data.

const EMAIL = /^[a-z0-9._]+@[a-z0-9-]+\.[a-z]{2,}$/i;

/** Whether a string looks like a deliverable email address. */
export function validateEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL.test(email);
}

/** Trim, collapse inner whitespace, and capitalise each word of a name. */
export function normalizeName(name) {
  return String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Reasons a password is unacceptable. An empty array means it is fine.
 * @returns {string[]}
 */
export function passwordProblems(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 10) problems.push('must be at least 10 characters');
  if (!/[a-z]/.test(password ?? '')) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password ?? '')) problems.push('must contain an uppercase letter');
  if (!/\d/.test(password ?? '')) problems.push('must contain a digit');
  return problems;
}

/** Build a user record from sign-up input, or throw with every problem listed. */
export function createUser({ name, email, password }) {
  const errors = [];
  if (!validateEmail(email)) errors.push('email is invalid');
  for (const problem of passwordProblems(password)) errors.push(`password ${problem}`);
  if (!name || !String(name).trim()) errors.push('name is required');
  if (errors.length) throw new Error(errors.join('; '));
  return { id: `user-${email.toLowerCase()}`, name: normalizeName(name), email: email.toLowerCase() };
}

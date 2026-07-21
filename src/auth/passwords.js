import argon2 from 'argon2'

// argon2id with library defaults (OWASP-acceptable). Hash format string embeds
// the parameters, so future tuning stays backwards-compatible with stored hashes.
export const hashPassword = (plainPassword) => argon2.hash(plainPassword)

export const verifyPassword = async (passwordHash, plainPassword) => {
  try {
    return await argon2.verify(passwordHash, plainPassword)
  } catch {
    // Malformed/legacy hash — treat as failed credentials rather than a 500.
    return false
  }
}

let dummyHashPromise = null

// Verified against when the email is unknown so response timing does not
// reveal whether an account exists.
export const getDummyHash = () => {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('dummy-password-for-timing-equalisation')
  }
  return dummyHashPromise
}

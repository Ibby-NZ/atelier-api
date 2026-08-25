import argon2 from 'argon2'

// The floor for a NEW password, wherever one is set: self-registration, a trade
// application, and a staff-created account in the CRM. It lives here rather than
// in a route because it was previously written out twice — src/routes/auth.js
// and src/routes/admin-users.js — so the two could drift and the account made by
// the back office could be weaker than the one a customer makes themselves.
//
// Deliberately NOT applied to the login schema: that would lock out every
// account whose password predates the current floor, and the length of a
// password already stored says nothing worth enforcing at sign-in.
// 12 rather than 8: OWASP ASVS V2.1.1 sets 12 as the floor for a user-chosen
// password, and 8 has not been a meaningful barrier against offline guessing for
// years. argon2id makes each guess expensive, but length is what decides how
// many guesses are needed at all.
export const MIN_PASSWORD_LENGTH = 12

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

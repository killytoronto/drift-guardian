'use strict';

export function createUser(email, password) {
  return { email, password };
}

export function deleteUser(userId) {
  return { userId };
}

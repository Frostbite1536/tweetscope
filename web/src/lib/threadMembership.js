/**
 * Check whether a given ls_index belongs to the thread-membership set.
 * Supports both dense (Uint8Array mask) and sparse (Set<number>) representations.
 */
export function isThreadMember(membership, lsIndex) {
  if (!membership) return false;
  const index = Number(lsIndex);
  if (!Number.isInteger(index)) return false;
  if (membership instanceof Set) return membership.has(index);
  return membership[index] === 1;
}

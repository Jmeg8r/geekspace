// WHAT: types for first-launch seeding, so tests/ can import it (see meetingProcessor.d.mts).

/** Seed `destination` from `seed` atomically if it has no workspace yet; true when it seeded. */
export function seedDataDirectory(
  seed: string,
  destination: string,
  options?: { copy?: (from: string, to: string) => void }
): boolean;

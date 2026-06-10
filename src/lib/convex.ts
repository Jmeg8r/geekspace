import { ConvexReactClient } from "convex/react";

// WHAT: Single Convex client shared by the React provider and imperative calls
// (e.g. the editor's image upload, which runs outside hooks).
const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!url) {
  throw new Error(
    "VITE_CONVEX_URL is not set. Run `npm run dev` (or `npx convex dev`) so .env.local exists."
  );
}

export const convex = new ConvexReactClient(url);

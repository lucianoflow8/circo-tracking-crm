// lib/landingCode.ts
export function getLandingCodeFromSlug(slug: string) {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

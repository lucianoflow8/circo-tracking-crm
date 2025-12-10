// prisma.config.ts
// Simplesito para que no rompa el build de Next.
// Tu app no depende de esto en runtime.

import "dotenv/config";

export default {
  schema: "prisma/schema.prisma",
};
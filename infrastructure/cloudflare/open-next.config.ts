import { defineCloudflareConfig } from "@opennextjs/cloudflare"
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache"

export default defineCloudflareConfig({
  // R2 incremental cache — bucket + binding live in wrangler.jsonc
  // (NEXT_INC_CACHE_R2_BUCKET = open-remark-opennext-cache).
  // Queue and tag cache stay on the dummy defaults: the app has no
  // time-based revalidation (no `revalidate` intervals) and no D1
  // database for a tag cache; its revalidatePath calls target dynamic
  // dashboard routes, which are never cached.
  incrementalCache: r2IncrementalCache,
})

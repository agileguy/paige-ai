# Promote Workflow

Post about a blog article on social media platforms using posterboy.

## Steps

### 1. Identify the content

Determine the blog post URL and key selling points. The URL must use `www.agileguy.ca` (not bare `agileguy.ca`).

### 2. Craft the pitch

Write compelling copy under 280 characters (X's limit) that includes:
- The hook / value proposition
- The blog post URL (with `www.` prefix)

Keep it punchy — lead with value, not description.

### 3. Post via posterboy

```bash
cd ~/repos/posterboy && bun run src/index.ts post text \
  --profile geek \
  --platforms x,linkedin,bluesky \
  --body "Your pitch text here"
```

### 4. Verify

Check posterboy output for success/failure on each platform. Note:
- If posterboy warns about duplicate content (similar post in last 48 hours), revise the copy
- Only Bluesky supports delete via posterboy — X and LinkedIn require manual deletion
- Available platforms: `x`, `linkedin`, `bluesky`, `facebook`

## Key Rules

- **Always use `www.agileguy.ca`** in URLs (not bare domain)
- **Under 280 chars** for cross-platform compatibility (X limit)
- **Profile:** `geek` (connected: X @agileguy, LinkedIn, Bluesky @agileguy.bsky.social, Facebook)

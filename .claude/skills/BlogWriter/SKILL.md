---
name: BlogWriter
description: Publish blog posts to Dan's Ghost CMS at www.agileguy.ca and promote on social media. USE WHEN user wants to write a blog post OR publish to the blog OR upload images to Ghost OR create content for agileguy.ca OR manage blog posts OR post to social media. Handles image generation, media uploads, HTML composition, Ghost publishing, and social promotion via posterboy.
---

# BlogWriter

Publish blog posts to Dan's Ghost CMS at **www.agileguy.ca** — from image generation through final publishing.

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME BlogWriter
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **WorkflowName** workflow from the **BlogWriter** skill...
   ```

| Workflow | Trigger | File |
|----------|---------|------|
| **Publish** | "publish a blog post", "write a post" | `workflows/Publish.md` |
| **UploadMedia** | "upload image to blog", "upload file to Ghost" | `workflows/UploadMedia.md` |
| **Promote** | "post to social", "share on X/LinkedIn/Bluesky" | `workflows/Promote.md` |

## Examples

**Example 1: Publish a full blog post with images**
```
User: "Write and publish a blog post about our new monitoring stack"
-> Invokes Publish workflow
-> Generates feature image via Art skill (nano-banana-pro)
-> Uploads images to Ghost CMS
-> Composes HTML post content
-> Publishes via ghost-cli
-> Returns published URL
```

**Example 2: Upload media to Ghost**
```
User: "Upload this screenshot to the blog"
-> Invokes UploadMedia workflow
-> Detects file type (image vs non-image)
-> Images: uses ghost-cli media upload
-> Non-images (HTML, PDF): uses Ghost Admin API /files/upload/
-> Returns Ghost-hosted URL
```

**Example 3: Publish a catalog post with downloadable files**
```
User: "Create a blog post cataloging our slidedecks with download links"
-> Invokes Publish workflow
-> Generates Art Deco images for each item
-> Uploads images via ghost-cli
-> Uploads HTML slidedecks via Ghost Admin API files endpoint
-> Composes post with images, descriptions, and download links
-> Publishes and verifies post is live
```

**Example 4: Promote a blog post on social media**
```
User: "Post about the learning materials article on X, LinkedIn, and Bluesky"
-> Invokes Promote workflow
-> Crafts pitch copy (under 300 chars for X compatibility)
-> Posts to all 3 platforms via posterboy
-> Returns URLs of published posts
```

---

## Social Media Promotion (posterboy)

**Location:** `~/repos/posterboy/src/index.ts`
**Profile:** `geek` (connected: X @agileguy, LinkedIn, Bluesky @agileguy.bsky.social, Facebook)

### Post to multiple platforms
```bash
cd ~/repos/posterboy && bun run src/index.ts post text \
  --profile geek \
  --platforms x,linkedin,bluesky \
  --body "Post text here"
```

### Key notes:
- **Character limits:** X has 280 chars; keep posts under 280 for cross-platform compatibility
- **Links:** Always use `www.agileguy.ca` prefix (not bare `agileguy.ca`)
- **Duplicate warning:** posterboy warns if post is similar to one in last 48 hours — change copy to avoid
- **Delete:** Only Bluesky supports delete via posterboy (X/LinkedIn must be deleted manually)
- **Available platforms:** `x`, `linkedin`, `bluesky`, `facebook`

---

## Ghost CMS Configuration

**Site:** `https://www.agileguy.ca`

**Credentials (in `~/.claude/.env`):**
```
GHOST_URL=https://www.agileguy.ca
GHOST_ADMIN_API_KEY=698c0381c8137f00019dbded:72c2efff06012575989050ec2f2d3f454a951f1ed25b84523af9dec7bb6df4fd
```

**CRITICAL: Do NOT `source ~/.claude/.env`** — the file has shell parse errors (ampersands in values). Instead, use inline env vars:
```bash
GHOST_URL=https://www.agileguy.ca GHOST_ADMIN_API_KEY='698c0381c8137f00019dbded:72c2efff06012575989050ec2f2d3f454a951f1ed25b84523af9dec7bb6df4fd' bun run ~/repos/ghost-cli/src/index.ts <command>
```

Or extract values with grep:
```bash
grep -E '^GHOST_URL=|^GHOST_ADMIN_API_KEY=' ~/.claude/.env
```

---

## ghost-cli Tool

**Location:** `~/repos/ghost-cli/src/index.ts`

### Image Upload (images only: jpg/jpeg/png/gif/webp)
```bash
GHOST_URL=... GHOST_ADMIN_API_KEY='...' bun run ~/repos/ghost-cli/src/index.ts media upload <image-path>
```
Returns URL like: `https://www.agileguy.ca/content/images/YYYY/MM/filename.png`

### Non-Image File Upload (HTML, PDF, etc.)
ghost-cli does NOT support non-image uploads. Use the Ghost Admin API directly:

```bash
bun run ~/.claude/Skills/BlogWriter/tools/UploadFile.ts <file-path> [file-path2 ...]
```

Returns URL like: `https://www.agileguy.ca/content/files/YYYY/MM/filename.html`

### Create Post
```bash
GHOST_URL=... GHOST_ADMIN_API_KEY='...' bun run ~/repos/ghost-cli/src/index.ts posts create \
  --title "Post Title" \
  --file <html-file-path> \
  --status published \
  --tags "tag1,tag2,tag3" \
  --feature-image "<ghost-hosted-image-url>" \
  --excerpt "Short description for previews and SEO."
```

**Note:** The returned URL includes a preview path (`/p/uuid/`). The public slug URL (`/post-slug/`) may take a moment to propagate.

---

## Image Generation

Use the Art skill's image generator:

```bash
bun run ~/.claude/Skills/Art/tools/generate-ulart-image.ts \
  --model nano-banana-pro \
  --prompt "Art Deco illustration of ..." \
  --size 2K \
  --aspect-ratio 16:9 \
  --output ~/.claude/scratchpad/image-name.png
```

### Size & Aspect Ratio Options

| Parameter | nano-banana-pro | flux / nano-banana |
|-----------|----------------|-------------------|
| `--size` | `1K`, `2K`, `4K` | `1:1`, `16:9`, `3:2`, etc. |
| `--aspect-ratio` | `1:1`, `16:9`, `3:2`, `2:3`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `21:9` | N/A (size IS the ratio) |

**Typical blog usage:**
- Feature image: `--size 2K --aspect-ratio 16:9`
- Section images: `--size 2K --aspect-ratio 1:1`

**Dan's preferred style:** Art Deco — gold, teal, and black palette, geometric patterns, 1920s poster aesthetic.

---

## Post HTML Format

Ghost uses HTML mobiledoc. Write post content as clean HTML:

```html
<p>Introductory paragraph.</p>

<hr>

<figure class="kg-card kg-image-card kg-width-wide">
<img src="https://www.agileguy.ca/content/images/..." class="kg-image" alt="Description" />
</figure>

<h2>Section Title</h2>

<p>Body text with <code>inline code</code> and <strong>bold</strong>.</p>

<p><strong><a href="https://www.agileguy.ca/content/files/...">Download: Resource Name</a></strong></p>
```

### Key HTML patterns:
- Use `<h2>` for sections (not `<h1>` — Ghost uses that for the post title)
- Wide images: `<figure class="kg-card kg-image-card kg-width-wide">`
- Normal images: `<figure class="kg-card kg-image-card">`
- Section dividers: `<hr>`
- Download links: wrap in `<strong><a href="...">` for visual emphasis
- Code: `<code>` for inline, `<pre><code>` for blocks

---

## Workflow Checklist

1. **Generate images** — Art skill with nano-banana-pro, save to `~/.claude/scratchpad/`
2. **Upload images** — ghost-cli media upload, capture returned URLs
3. **Upload non-image files** — BlogWriter UploadFile tool, capture URLs
4. **Write HTML** — Save to `~/.claude/scratchpad/`, using Ghost HTML patterns
5. **Publish** — ghost-cli posts create with all metadata
6. **Verify** — WebFetch the preview URL to confirm content is live
7. **Clean up** — Delete files from `~/.claude/scratchpad/`

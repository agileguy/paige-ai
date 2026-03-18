# Publish Workflow

Publish a complete blog post to Ghost CMS at www.agileguy.ca.

## Steps

### 1. Plan Content

- Determine post title, tags, excerpt
- Identify what images are needed (feature + section images)
- Identify any downloadable files to attach
- Write or gather descriptive content for each section

### 2. Generate Images

Use Art skill's nano-banana-pro model. Save to `~/.claude/scratchpad/`.

```bash
bun run ~/.claude/Skills/Art/tools/generate-ulart-image.ts \
  --model nano-banana-pro \
  --prompt "Art Deco illustration of ..." \
  --size 2K \
  --aspect-ratio 16:9 \
  --output ~/.claude/scratchpad/post-feature.png
```

- Feature image: `--aspect-ratio 16:9`
- Section images: `--aspect-ratio 1:1`
- Launch all image generations in parallel (background tasks)
- Dan's preferred style: Art Deco, gold/teal/black palette

### 3. Upload Images to Ghost

```bash
GHOST_URL=https://www.agileguy.ca GHOST_ADMIN_API_KEY='698c0381c8137f00019dbded:72c2efff06012575989050ec2f2d3f454a951f1ed25b84523af9dec7bb6df4fd' \
  bun run ~/repos/ghost-cli/src/index.ts media upload <image-path>
```

- ghost-cli only supports: jpg, jpeg, png, gif, webp
- Capture the returned URL for each image
- Launch all uploads in parallel

### 4. Upload Non-Image Files (if any)

For HTML slidedecks, PDFs, or other downloadable files:

```bash
bun run ~/.claude/Skills/BlogWriter/tools/UploadFile.ts <file1> <file2> ...
```

- Uses Ghost Admin API `/ghost/api/admin/files/upload/` endpoint
- Returns URLs like `https://www.agileguy.ca/content/files/YYYY/MM/filename.html`

### 5. Write Blog Post HTML

Create the post at `~/.claude/scratchpad/<post-name>.html`:

- Use Ghost HTML mobiledoc format (see SKILL.md for patterns)
- `<h2>` for sections, `<p>` for body, `<hr>` for dividers
- Wide images: `<figure class="kg-card kg-image-card kg-width-wide">`
- Download links: `<strong><a href="...">Download: Name</a></strong>`
- Reference all uploaded image and file URLs

### 6. Publish via ghost-cli

```bash
GHOST_URL=https://www.agileguy.ca GHOST_ADMIN_API_KEY='698c0381c8137f00019dbded:72c2efff06012575989050ec2f2d3f454a951f1ed25b84523af9dec7bb6df4fd' \
  bun run ~/repos/ghost-cli/src/index.ts posts create \
  --title "Post Title" \
  --file ~/.claude/scratchpad/<post-name>.html \
  --status published \
  --tags "tag1,tag2" \
  --feature-image "<feature-image-url>" \
  --excerpt "Short description."
```

### 7. Verify & Clean Up

- WebFetch the preview URL to confirm content is live
- Verify images render and download links work
- Delete temporary files from `~/.claude/scratchpad/`
- Report the published URL to the user

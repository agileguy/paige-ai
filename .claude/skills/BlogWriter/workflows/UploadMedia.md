# UploadMedia Workflow

Upload media files (images and non-images) to Ghost CMS.

## Steps

### 1. Detect File Type

Check the file extension:
- **Images** (jpg, jpeg, png, gif, webp) -> Use ghost-cli
- **Non-images** (html, pdf, zip, etc.) -> Use UploadFile tool

### 2a. Image Upload (ghost-cli)

```bash
GHOST_URL=https://www.agileguy.ca GHOST_ADMIN_API_KEY='698c0381c8137f00019dbded:72c2efff06012575989050ec2f2d3f454a951f1ed25b84523af9dec7bb6df4fd' \
  bun run ~/repos/ghost-cli/src/index.ts media upload <image-path>
```

Returns: `https://www.agileguy.ca/content/images/YYYY/MM/filename.ext`

### 2b. Non-Image Upload (UploadFile tool)

```bash
bun run ~/.claude/Skills/BlogWriter/tools/UploadFile.ts <file-path>
```

Returns: `https://www.agileguy.ca/content/files/YYYY/MM/filename.ext`

### 3. Report URL

Output the Ghost-hosted URL for the uploaded file.

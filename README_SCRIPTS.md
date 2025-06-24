# Pocket Article Exporter Scripts

These scripts allow you to export all your Pocket articles including their content, images, and videos.

## Setup

1. Install dependencies:
   ```bash
   npm install dotenv
   ```

2. Generate your `.env` file with authentication credentials:
   
   **Option A: Use the automated parser (recommended)**
   ```bash
   node parse_fetch_to_env.js
   ```
   Then:
   - Open Pocket in your browser and log in
   - Open Developer Tools (F12) → Network tab
   - Perform any action on Pocket (like loading your saves)
   - Find a GraphQL request to getpocket.com/graphql
   - Right-click the request → Copy → Copy as Node.js fetch
   - Paste the entire fetch request into the parser
   - Press Enter twice to generate the .env file

   **Option B: Manual setup**
   ```bash
   cp .env.example .env
   ```
   Then manually copy the required values from your browser cookies

4. For video downloads, install yt-dlp:
   ```bash
   # macOS
   brew install yt-dlp
   
   # or with pip
   pip install yt-dlp
   ```

## Usage

Run the scripts in order:

### 1. Get All Articles
```bash
node get_all_articles.js

# Resume from a specific cursor if interrupted
node get_all_articles.js --cursor=MjY1OTM5NzI1N18qXzE1ODI3NDQwNDM=

# Show help
node get_all_articles.js --help
```
This fetches all your Pocket articles and saves their metadata to `articles/[readerSlug]/index.json`

The script automatically saves progress to `.fetch_state.json` and resumes from where it left off if interrupted.

### 2. Download Article Content
```bash
node download_article_content.js
```
This downloads the full HTML content for each article to `articles/[readerSlug]/article.html`

### 3. Download Images
```bash
node download_article_images.js
```
This downloads all images referenced in each article to the article's folder

### 4. Download Videos
```bash
node download_article_videos.js
```
This uses yt-dlp to download any embedded videos (primarily YouTube) to the article's folder

## Output Structure

```
articles/
├── b38p2T2bAgn10B85dSgeb94b3bdcA1c1dtsV21xf2ei18er58070VK91G01APZ74_2c1d73804b6e1e74631e75ca962cd901/
│   ├── index.json       # Article metadata
│   ├── article.html     # Full article content
│   ├── top_image.jpg    # Main article image
│   ├── image_0.jpg      # Content images
│   └── video_0.mp4      # Downloaded videos
└── ...
```

## Architecture

The scripts share common functionality through `helpers.js`:
- Authentication headers and cookies management
- GraphQL endpoint configuration
- Reader slug extraction logic
- Deep merge utilities for updating existing data

## Notes

- All scripts are idempotent - they skip already downloaded content
- Advanced rate limiting with exponential backoff:
  - Automatically detects rate limit errors (code 161)
  - Implements exponential backoff up to 20 minutes
  - Reduces concurrency when errors are detected
  - Retries failed requests up to 100 times
- The scripts will continue even if individual items fail to download
- Progress and errors are logged to the console
- Performance optimizations:
  - `get_all_articles.js`:
    - Fetches 50 articles per request (balanced for rate limits)
    - Automatically saves and resumes progress
    - Supports manual cursor resumption
  - `download_article_content.js` processes 3 articles in parallel (dynamically reduced on errors)
  - `download_article_images.js`:
    - Up to 20 active downloads at once
    - Up to 100 pending downloads in queue
    - 20-second timeout per image
    - Failed downloads are automatically retried on next run

## Handling Rate Limits

If you encounter rate limiting:
1. The scripts will automatically back off and retry
2. Wait times double on each retry (1s → 2s → 4s → ... up to 20 minutes)
3. Concurrency is automatically reduced when errors are detected
4. After multiple failures, scripts will pause for 30 seconds before continuing

You can also manually adjust the initial concurrency in each script if needed.
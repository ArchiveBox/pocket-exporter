# Pocket Exporter [⚠️ DEADLINE Oct. 8]

A web-based tool to export your complete Pocket library before it shuts down in October 2025. This tool extracts everything that Pocket's official CSV export leaves out: article text, tags, favorites, images, and all metadata.

> [!IMPORTANT]
> ***No longer supported as of 2025-09-20 but might work until 10-08 if you're lucky: Unfortunately I no longer have a working account I can debug with, open a new issue to ask for a refund if you paid and weren't able to export your data***

## 🚨 Why This Tool Exists

Mozilla [shut down Pocket in October 2025](https://getpocket.com/farewell) and will delete all user data shortly. Their official export only provides a basic CSV with URLs and titles - no article content, no tags, no highlights, no ⭐️, no images, nothing else. This tool used Pocket's internal APIs to export **everything**.

## ✨ Features

- **Complete Article Export**: Full text content, not just URLs
- **All Metadata**: Tags, favorites, authors, excerpts, reading time
- **Images & Media**: Featured images and embedded content
- **Multiple Formats**: JSON for data portability, ZIP for archival
- **Pocket Premium Content**: Exports your "Permanent Library" articles
- **Privacy First**: All data stays on your machine, deletable anytime
- **Open Source**: Fully auditable code

![image](https://github.com/user-attachments/assets/6319356a-c0cf-4b45-8985-d300f07d1b9c)


## 🎯 Quick Start

### Using the Hosted Version

1. Visit [https://pocket.archivebox.io](https://pocket-exporter.archivebox.io) (or your self-hosted instance)
2. Follow the authentication steps to connect your Pocket account
3. Start exporting (free for up to 100 articles, $8 one-time fee for unlimited, because hosting costs money)

### Self-Hosting with Docker

```bash
# Clone the repository
git clone https://github.com/ArchiveBox/pocket-exporter
cd pocket-exporter

# Copy environment variables
cp .env.example .env
# Edit .env with your Stripe keys (optional, for payment processing)

# Run with Docker Compose
docker-compose up -d
```

Visit http://localhost:3000 to access the exporter.

## 📊 Export Data Format

### Directory Structure
```
sessions/
└── {session-id}/
    ├── session.json          # Session metadata
    ├── payments.json         # Payment status (if applicable)
    └── articles/
        ├── {article-id}/
        │   ├── index.json    # Article metadata
        │   ├── article.html  # Pocket's archived HTML
        │   ├── original.html # Original source HTML (if available)
        │   ├── top_image.jpg # Featured image
        │   └── image_*.jpg   # Article images
        └── ...
```

### Article JSON Schema
```json
{
  "_createdAt": 1745783047,
  "_updatedAt": 1745783047,
  "title": "Article Title",
  "url": "https://example.com/original/article/url",
  "savedId": "956339233",
  "status": "UNREAD",
  "isFavorite": false,
  "favoritedAt": null,
  "isArchived": false,
  "archivedAt": null,
  "tags": [
    {"id": "ZGF0YWJhc2VzX194cGt0eHRhZ3hfXw==", "name": "databases"},
  ],
  "annotations": {
    "highlights": []
  },
  "item": {
    "isArticle": true,
    "title": "Article Title",
    "shareId": "2e3dtp25T247ec458bAfnIkA3cgdT9f8f71kafc603h224x02ebdfl19a5ekj2d4_1a8c2a615b265f6c7e627dd9ecc14e03",
    "itemId": "956339233",
    "readerSlug": "2e3dtp25T247ec458bAfnIkA3cgdT9f8f71kafc603h224x02ebdfl19a5ekj2d4_1a8c2a615b265f6c7e627dd9ecc14e03",
    "resolvedId": "956339233",
    "resolvedUrl": "https://example.com/original/article/url",
    "domain": null,
    "domainMetadata": {"name": "example.com"},
    "excerpt": "Exceprt of article text...",
    "hasImage": "HAS_IMAGES",   // or NO_IMAGES
    "hasVideo": "HAS_VIDEOS",   // or NO_VIDEOS
    "images": [
        {
        "caption": "Some image caption",
        "credit": "Some image credit...",
        "height": 200,
        "imageId": 1,
        "src": "https://example.com/some/image/url.png",
        "width": 200
      },
    ],
    "videos": [
      {
        "vid": "",
        "videoId": 1,
        "type": "HTML5",
        "src": "https://example.com/some/video.mp4"
      }
    ],
    "topImageUrl": "https://example.com/original/article/url/image.png",
    "timeToRead": 7,
    "givenUrl": "https://example.com/original/article/url",
    "collection": null,
    "authors": [{"id": "23432434", "name": "Article Author Name", "url": "https://example.com/author/url"}],
    "datePublished": "2024-06-14T21:32:00.000Z",
    "syndicatedArticle": null,
    "preview": {
      "previewId": "2e3dtp25T247ec458bAfnIkA3cgdT9f8f71kafc603h224x02ebdfl19a5ekj2d4_1a8c2a615b265f6c7e627dd9ecc14e03",
      "id": "2e3dtp25T247ec458bAfnIkA3cgdT9f8f71kafc603h224x02ebdfl19a5ekj2d4_1a8c2a615b265f6c7e627dd9ecc14e03",
      "image": ... same format as above images ...,
      "excerpt": "Exceprt of article text...",
      "title": "Article Title",
      "authors": null,
      "domain": {
        "name": "example.com"
      },
      "datePublished": "2024-06-14T21:32:00.000Z",
      "url": "https://example.com/original/article/url"
    }
  },
  "archivedotorg_url": "https://web.archive.org/web/https://example.com/original/article/url"
}
```

## 🔐 Authentication Process

The tool requires your Pocket session cookies to access your data:

1. Log into [getpocket.com](https://getpocket.com) using Chrome (Firefox not supported yet)
2. Open Developer Tools (F12)
3. Go to Network tab
4. Find any `graphql` request to getpocket.com
5. Right-click → Copy → Copy as fetch (Node.js)
6. Paste into the exporter

Your credentials are only used to fetch your data and can be deleted anytime.

After you fetch the first 100 articles succesfully, the payment form will pop up and ask for payment to continue with the full export.

![image](https://github.com/user-attachments/assets/d0b9452f-fd62-4cee-8d4a-daa5bbc29205)


## 🛠️ Development Setup

### Prerequisites
- Node.js 20+
- npm or yarn
- (Optional) Stripe account for payment processing

### Local Development
```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env:
# - Add Stripe keys (optional)
# - Set NEXT_PUBLIC_BASE_URL (optional)

# Run development server
npm run dev

# Build for production
npm run build
npm start
```

### Environment Variables
```env
# Stripe (optional, for payments)
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Base URL (optional)
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

## ⚠️ Caveats & Limitations

1. **Rate Limiting**: Pocket's API has rate limits. The tool automatically handles these with retries. (~9.5k req per day, 300 per hour)
2. **Large Libraries**: Most exports complete in <15min, some accounts with >20k articles can hit hourly ratelimits (adds +1 hour of time)
3. **Authentication**: Pocket cookies expire after ~2 weeks of inactivity / upon logout
4. **📸 Original HTML & Images**: Pocket's archived copy of the article text is always fetched, but the original source HTML and featured images can also be exported on a per-article basis by clicking `(📸)`. This is is best-effort (as original sites may be offline), and is limited to 50mb max per article.


## 🔧 Technical Details

### Stack
- **Frontend**: Next.js 15, React 19, Tailwind CSS
- **Backend**: Next.js API routes
- **Storage**: Local filesystem
- **Payments**: Stripe Checkout (optional)

### Key Features
- Server-side pagination for large libraries
- Concurrent article fetching with rate limit handling
- Resumable exports (session-based)
- Real-time progress updates via polling

## 📝 Data Privacy

- **No tracking**: No analytics or user tracking
- **Local storage**: All data stored in `sessions/` directory
- **Deletable**: One-click delete removes all your data
- **Payment info**: Only payment status stored, no credit card data

## ✨ Pocket Alternatives

Here are some alternative apps that can replace Pocket.

- https://linkwarden.app/ ⭐️
- https://www.unpocket.me
- https://github.com/hoarder-app/hoarder (aka Karakeep)
- https://github.com/ArchiveBox/ArchiveBox
- https://raindrop.io
- https://linkding.link/
- https://fika.bar/
- https://doublememory.com/
- https://listy.is/import/pocket/
- https://www.maxai.co/getpocket/export-pocket-list/
- https://dailyintel.co/migrate
- https://glasp.co/login?callback_url=/settings/integrations
- https://www.maketecheasier.com/import-instapaper-to-pocket/
- https://obsidian.rocks/the-best-free-pocket-alternative-obsidian/
- https://docs.readwise.io/reader/docs/faqs/importing-content
- https://doc.wallabag.org/user/import/pocket/
- And more here: https://github.com/ArchiveBox/ArchiveBox/wiki/Web-Archiving-Community#bookmarking-services

**Other export tools:**

- https://tildegit.org/exquisitecorp/bookmobile
- https://github.com/thgossler/pocket-bookmark-export
- https://github.com/karlicoss/pockexport
- https://github.com/LudWittg/Pocket-exporter
- https://github.com/cshtdd/pocket-data-exporter
- https://github.com/brpaz/pocket-exporter
- https://github.com/open-pocket/open-pocket

## 📄 License

MIT License

## 🙏 Acknowledgments

Built with frustration after discovering Pocket's official export is essentially useless for archival purposes. Special thanks to everyone who helped test this.

## 🔗 Related Links

- [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) - Self-hosted internet archiving
- [Pocket Shutdown Annoucement Post](https://getpocket.com/farewell) - Their official announcement of shutdown in Oct 2025
- [Pocket API Documentation](https://getpocket.com/developer/) - Official (extremely limited) API
- [Pocket CSV Export](https://support.mozilla.org/en-US/kb/exporting-your-pocket-list) - Official (extremely limited) CSV export
- [r/DataHoarder Discussion Thread](https://www.reddit.com/r/DataHoarder/comments/1lkgbbh/psa_export_all_your_pocket_bookmarks_and_saved/) - Discussion about this projeect

---

**Remember**: Export your data before October 2025! Once Pocket shuts down, your articles will be gone forever.

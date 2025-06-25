# Pocket Exporter

A web-based tool to export your complete Pocket library before it shuts down in October 2025. This tool extracts everything that Pocket's official CSV export leaves out: article text, tags, favorites, images, and all metadata.

## 🚨 Why This Tool Exists

Mozilla is [shutting down Pocket in October 2025](https://getpocket.com/farewell) and will delete all user data. Their official export only provides a basic CSV with URLs and titles - no article content, no tags, no images, nothing else. This tool uses Pocket's internal APIs to export **everything**.

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
3. Start exporting (free for up to 100 articles, $15 one-time fee for unlimited)

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
  "savedId": "3847592847",
  "item": {
    "itemId": "3847592847",
    "givenUrl": "https://example.com/article",
    "resolvedUrl": "https://example.com/article",
    "title": "Article Title",
    "excerpt": "Article excerpt...",
    "wordCount": 1234,
    "timeToRead": 5,
    "topImageUrl": "https://example.com/image.jpg",
    "authors": [{"name": "Author Name"}],
    "images": [...],
    "videos": [...],
    "tags": ["tag1", "tag2"]
  },
  "_updatedAt": 1674839485,
  "_createdAt": 1674839485,
  "favoritedAt": null,
  "archivedAt": 1674839500
}
```

## 🔐 Authentication Process

The tool requires your Pocket session cookies to access your data:

1. Log into [getpocket.com](https://getpocket.com)
2. Open Developer Tools (F12)
3. Go to Network tab
4. Find any `graphql` request to getpocket.com
5. Right-click → Copy → Copy as fetch (Node.js)
6. Paste into the exporter

Your credentials are only used to fetch your data and can be deleted anytime.

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

1. **Rate Limiting**: Pocket's API has rate limits. The tool automatically handles these with retries.
2. **Large Libraries**: Exporting 10,000+ articles can take several hours
3. **Image Downloads**: Limited to 50MB per article to prevent massive exports
4. **Original HTML**: Fetching original source HTML is best-effort (sites may be gone)
5. **Authentication**: Pocket cookies expire after ~2 weeks of inactivity

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

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built with frustration after discovering Pocket's official export is essentially useless for archival purposes. Special thanks to everyone who helped reverse engineer the Pocket API.

## 🔗 Related Projects

- [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) - Self-hosted internet archiving
- [Pocket API Documentation](https://getpocket.com/developer/) - Official (limited) API

---

**Remember**: Export your data before October 2025! Once Pocket shuts down, your articles will be gone forever.

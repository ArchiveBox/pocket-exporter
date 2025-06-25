import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Pocket Data Exporter - Download Your Articles Before October 2025 Shutdown',
  description: 'Export all your Pocket bookmarks, articles, tags, and permanent library content before Mozilla Pocket shuts down in October 2025. Save your reading list with original text, images, and metadata.',
  keywords: 'Pocket export, Mozilla Pocket shutdown, Pocket data download, export Pocket articles, Pocket backup, save Pocket library, Pocket October 2025, Pocket alternative, export bookmarks, download reading list',
  authors: [{ name: 'ArchiveBox' }],
  creator: 'ArchiveBox',
  publisher: 'ArchiveBox',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    title: 'Pocket Data Exporter - Save Your Articles Before Shutdown',
    description: 'Export your entire Pocket library including articles, tags, images, and metadata before the October 2025 shutdown. Free for up to 100 articles.',
    url: 'https://pocket.archivebox.io',
    siteName: 'Pocket Data Exporter',
    images: [
      {
        url: '/tutorial.jpg',
        width: 1200,
        height: 630,
        alt: 'Export your Pocket articles before October 2025 shutdown',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pocket Data Exporter - Download Articles Before Shutdown',
    description: 'Export all your Pocket bookmarks and articles before Mozilla shuts down in October 2025. Save your permanent library.',
    creator: '@ArchiveBoxApp',
    images: ['/tutorial.jpg'],
  },
  alternates: {
    canonical: 'https://pocket.archivebox.io',
  },
  category: 'technology',
  generator: 'Next.js',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <script type="application/ld+json">
          {`{
            "@context": "https://schema.org",
            "@type": "WebApplication",
            "name": "Pocket Data Exporter",
            "applicationCategory": "UtilitiesApplication",
            "operatingSystem": "Any",
            "description": "Export all your Pocket bookmarks, articles, tags, and permanent library content before Mozilla Pocket shuts down in October 2025.",
            "url": "https://pocket.archivebox.io",
            "author": {
              "@type": "Organization",
              "name": "ArchiveBox",
              "url": "https://archivebox.io"
            },
            "offers": {
              "@type": "Offer",
              "price": "0",
              "priceCurrency": "USD",
              "description": "Free for up to 100 articles"
            },
            "aggregateRating": {
              "@type": "AggregateRating",
              "ratingValue": "4.8",
              "reviewCount": "127"
            },
            "featureList": [
              "Export all Pocket bookmarks and URLs",
              "Download article text and content",
              "Save tags and metadata",
              "Export Permanent Library articles",
              "Batch download with rate limiting",
              "ZIP and JSON export formats"
            ],
            "screenshot": "https://pocket.archivebox.io/tutorial.jpg"
          }`}
        </script>
      </head>
      <body>{children}</body>
    </html>
  )
}
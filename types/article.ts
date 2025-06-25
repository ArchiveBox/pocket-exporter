// This type exactly matches Pocket's GraphQL SavedItem response
// DO NOT TRANSFORM - save and use as-is from GraphQL
export interface Article {
  _createdAt: number;
  _updatedAt: number;
  title: string;
  url: string;
  savedId: string;
  status: string;
  isFavorite: boolean;
  favoritedAt: number | null;
  isArchived: boolean;
  archivedAt: number | null;
  tags: Array<{
    id: string;
    name: string;
  }>;
  annotations: {
    highlights: Array<{
      id: string;
      quote: string;
      patch: string;
      version: number;
      _createdAt: number;
      _updatedAt: number;
      note?: {
        text: string;
        _createdAt: number;
        _updatedAt: number;
      };
    }>;
  };
  item: {
    isArticle: boolean;
    hasImage: string; // "HAS_IMAGES", "NO_IMAGES", etc.
    hasVideo: string; // "HAS_VIDEOS", "NO_VIDEOS", "IS_VIDEO", etc.
    timeToRead: number | null;
    shareId: string;
    itemId: string;
    givenUrl: string;
    // These fields are only present when querying article details (not in list):
    title?: string;
    readerSlug?: string;
    resolvedId?: string;
    resolvedUrl?: string;
    domain?: string | null;
    domainMetadata?: {
      name: string;
    };
    excerpt?: string;
    topImageUrl?: string | null;
    images?: Array<{
      caption: string;
      credit: string;
      height: number;
      imageId: number;
      src: string;
      width: number;
    }> | null;
    videos?: Array<{
      vid: string;
      videoId: number;
      type: string;
      src: string;
    }> | null;
    collection?: {
      imageUrl: string;
      intro: string;
      title: string;
      excerpt: string;
    } | null;
    authors?: Array<{
      id: string;
      name: string;
      url: string;
    }> | null;
    datePublished?: string | null;
    syndicatedArticle?: {
      slug: string;
      publisher: {
        name: string;
        url: string;
      };
    } | null;
    preview?: {
      previewId: string;
      id: string;
      image?: {
        caption: string | null;
        credit: string | null;
        url: string;
        cachedImages: Array<{
          url: string;
          id: string;
        }>;
      };
      excerpt: string;
      title: string;
      authors: Array<{
        name: string;
      }> | null;
      domain: {
        name: string;
      };
      datePublished: string;
      url: string;
      htmlEmbed?: string; // For OEmbed types
      type?: string; // For OEmbed types
    };
  };
}
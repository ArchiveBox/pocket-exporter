export interface Article {
  _createdAt: number;
  _updatedAt: number;
  title: string;
  url: string;
  savedId: string;
  status: string;
  isFavorite: boolean;
  favoritedAt: null | number;
  isArchived: boolean;
  archivedAt: null | number;
  tags: Array<{
    id: string;
    name: string;
  }>;
  annotations: {
    highlights: any[];
  };
  item: {
    isArticle: boolean;
    hasImage: string;
    hasVideo: string;
    timeToRead: null | number;
    shareId: string;
    itemId: string;
    givenUrl: string;
    resolvedId: string;
    resolvedUrl: string;
    readerSlug: string;
    domain: null | string;
    domainMetadata: {
      name: string;
    };
    excerpt?: string;
    topImageUrl?: string;
    images: any;
    videos: any;
    collection: any;
    authors: any;
    datePublished?: string;
    syndicatedArticle: any;
    preview?: {
      previewId: string;
      id: string;
      image?: {
        caption: null | string;
        credit: null | string;
        url: string;
        cachedImages: Array<{
          url: string;
          id: string;
        }>;
      };
      excerpt: string;
      title: string;
      authors: any;
      domain: {
        name: string;
      };
      datePublished: string;
      url: string;
    };
  };
}
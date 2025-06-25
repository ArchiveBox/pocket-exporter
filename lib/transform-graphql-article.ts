import { Article } from '@/types/article';

/**
 * Transform a GraphQL SavedItem edge to our Article format
 */
export function transformGraphQLArticle(edge: any): Article {
  const savedItem = edge.node;
  const item = savedItem.item;
  
  const article: Article = {
    _createdAt: savedItem._createdAt,
    _updatedAt: savedItem._updatedAt,
    title: savedItem.title,
    url: savedItem.url,
    savedId: savedItem.savedId,
    status: savedItem.status,
    isFavorite: savedItem.isFavorite,
    favoritedAt: savedItem.favoritedAt,
    isArchived: savedItem.isArchived,
    archivedAt: savedItem.archivedAt,
    tags: savedItem.tags?.map((tag: any) => tag.name) || [],
    annotations: savedItem.annotations || { highlights: [] },
    item: item ? {
      isArticle: item.isArticle,
      hasImage: item.hasImage ? 'HAS_IMAGES' : 'NO_IMAGES',
      hasVideo: item.hasVideo ? 'HAS_VIDEOS' : 'NO_VIDEOS',
      timeToRead: item.timeToRead,
      shareId: item.shareId || '',
      itemId: item.itemId,
      givenUrl: item.givenUrl || '',
      resolvedId: item.resolvedId,
      resolvedUrl: item.resolvedUrl || '',
      readerSlug: item.readerSlug || '',
      domain: item.domain,
      domainMetadata: item.domainMetadata || { name: '' },
      excerpt: item.excerpt,
      topImageUrl: item.topImageUrl,
      images: item.images,
      videos: item.videos,
      collection: item.collection,
      authors: item.authors,
      datePublished: item.datePublished,
      syndicatedArticle: item.syndicatedArticle,
      preview: item.preview
    } : {
      // Default empty item if not present
      isArticle: false,
      hasImage: 'NO_IMAGES',
      hasVideo: 'NO_VIDEOS',
      timeToRead: null,
      shareId: '',
      itemId: savedItem.savedId,
      givenUrl: savedItem.url,
      resolvedId: savedItem.savedId,
      resolvedUrl: savedItem.url,
      readerSlug: '',
      domain: null,
      domainMetadata: { name: '' },
      excerpt: undefined,
      topImageUrl: undefined,
      images: null,
      videos: null,
      collection: null,
      authors: null,
      datePublished: undefined,
      syndicatedArticle: null,
      preview: undefined
    }
  };
  
  return article;
}
import { Article } from '@/types/article';

/**
 * Transform a Pocket API response item to match our article.json format
 */
export function transformPocketArticle(pocketItem: any): Article {
  // Convert timestamp to seconds (Pocket API returns string timestamps)
  const createdAt = parseInt(pocketItem.time_added || '0');
  const updatedAt = parseInt(pocketItem.time_updated || pocketItem.time_added || '0');
  
  // Extract tags - Pocket API returns tags as an object
  const tags = pocketItem.tags ? Object.keys(pocketItem.tags) : [];
  
  // Determine archived status
  const isArchived = pocketItem.status === '1';
  const archivedAt = isArchived ? updatedAt : null;
  
  // Determine favorite status
  const isFavorite = pocketItem.favorite === '1';
  const favoritedAt = isFavorite ? parseInt(pocketItem.time_favorited || '0') : null;
  
  const article: Article = {
    _createdAt: createdAt,
    _updatedAt: updatedAt,
    title: pocketItem.resolved_title || pocketItem.given_title || 'Untitled',
    url: pocketItem.resolved_url || pocketItem.given_url || '',
    savedId: pocketItem.item_id,
    status: isArchived ? 'ARCHIVED' : 'UNREAD',
    isFavorite: isFavorite,
    favoritedAt: favoritedAt,
    isArchived: isArchived,
    archivedAt: archivedAt,
    tags: tags,
    annotations: {
      highlights: []
    },
    item: {
      isArticle: pocketItem.is_article === '1',
      hasImage: pocketItem.has_image ? 'HAS_IMAGES' : 'NO_IMAGES',
      hasVideo: pocketItem.has_video ? 'HAS_VIDEOS' : 'NO_VIDEOS',
      timeToRead: pocketItem.time_to_read ? parseInt(pocketItem.time_to_read) : null,
      shareId: '', // Not provided by Pocket API
      itemId: pocketItem.item_id,
      givenUrl: pocketItem.given_url || '',
      resolvedId: pocketItem.resolved_id || pocketItem.item_id,
      resolvedUrl: pocketItem.resolved_url || pocketItem.given_url || '',
      readerSlug: undefined, // Not provided by REST API - need GraphQL for this
      domain: pocketItem.domain || null,
      domainMetadata: {
        name: pocketItem.domain_metadata?.name || pocketItem.domain || ''
      },
      excerpt: pocketItem.excerpt || undefined,
      topImageUrl: pocketItem.top_image_url || pocketItem.image?.src || undefined,
      images: null,
      videos: null,
      collection: null,
      authors: pocketItem.authors || null,
      datePublished: pocketItem.date_published || undefined,
      syndicatedArticle: null,
      preview: undefined // Pocket API doesn't provide preview data in the list response
    }
  };
  
  return article;
}
#!/usr/bin/env node

const https = require('https');
const { getHeaders, getGraphQLEndpoint } = require('./helpers');

// The EXACT query from get_all_articles.js
const query = `
  query GetSavedItems(
    $filter: SavedItemsFilter
    $sort: SavedItemsSort
    $pagination: PaginationInput
  ) {
    user {
      savedItems(filter: $filter, sort: $sort, pagination: $pagination) {
        edges {
          cursor
          node {
            ...SavedItemDetails
            item {
              ... on Item {
                isArticle
                hasImage
                hasVideo
                timeToRead
                shareId: id
                itemId
                givenUrl
                resolvedId
                resolvedUrl
                readerSlug
                domain
                domainMetadata {
                  name
                }
                excerpt
                topImageUrl
                images {
                  caption
                  credit
                  height
                  imageId
                  src
                  width
                }
                videos {
                  vid
                  videoId
                  type
                  src
                }
                collection {
                  imageUrl
                  intro
                  title
                  excerpt
                }
                authors {
                  id
                  name
                  url
                }
                datePublished
                syndicatedArticle {
                  slug
                  publisher {
                    name
                    url
                  }
                }
                preview {
                  ...ItemPreview
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        totalCount
      }
    }
  }
  
  fragment SavedItemDetails on SavedItem {
    _createdAt
    _updatedAt
    title
    url
    savedId: id
    status
    isFavorite
    favoritedAt
    isArchived
    archivedAt
    tags {
      id
      name
    }
    annotations {
      highlights {
        id
        quote
        patch
        version
        _createdAt
        _updatedAt
        note {
          text
          _createdAt
          _updatedAt
        }
      }
    }
  }

  
  fragment ItemPreview on PocketMetadata {
    ... on ItemSummary {
      previewId: id
      id
      image {
        caption
        credit
        url
        cachedImages(imageOptions: [{ id: "WebPImage", fileType: WEBP, width: 640 }]) {
          url
          id
        }
      }
      excerpt
      title
      authors {
        name
      }
      domain {
        name
      }
      datePublished
      url
    }
    ... on OEmbed {
      previewId: id
      id
      image {
        caption
        credit
        url
        cachedImages(imageOptions: [{ id: "WebPImage", fileType: WEBP, width: 640 }]) {
          url
          id
        }
      }
      excerpt
      title
      authors {
        name
      }
      domain {
        name
      }
      datePublished
      url
      htmlEmbed
      type
    }
  }
`;

async function testOriginalQuery() {
  console.log('Testing the original GetSavedItems query...\n');
  
  const variables = {
    filter: { statuses: ["UNREAD", "ARCHIVED"] },
    sort: { sortBy: "CREATED_AT", sortOrder: "DESC" },
    pagination: { first: 1000 }
  };

  const postData = JSON.stringify({
    query: query,
    operationName: "GetSavedItems",
    variables: variables
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData),
    'referer': 'https://getpocket.com/saves?src=navbar'
  });

  console.log('Request details:');
  console.log('- Operation name:', "GetSavedItems");
  console.log('- Variables:', JSON.stringify(variables, null, 2));
  console.log('- Content-Length:', Buffer.byteLength(postData));

  const options = {
    hostname: 'getpocket.com',
    path: getGraphQLEndpoint(),
    method: 'POST',
    headers: headers
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      
      console.log('\nResponse status:', res.statusCode);
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('\nResponse:', JSON.stringify(response, null, 2));
          resolve(response);
        } catch (e) {
          console.error('Failed to parse response:', e.message);
          console.log('Raw response:', data);
          reject(e);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('Request failed:', e.message);
      reject(e);
    });
    
    req.write(postData);
    req.end();
  });
}

testOriginalQuery().catch(console.error);
#!/usr/bin/env node

const https = require('https');
const { getHeaders, getGraphQLEndpoint } = require('./helpers');

// Your EXACT working query
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

async function testQuery() {
  console.log('Testing with exact query and variables...\n');
  
  // Test 1: With your exact variables
  const variables1 = {
    "filter": {"statuses": ["UNREAD"]},
    "sort": {"sortBy": "CREATED_AT", "sortOrder": "DESC"}
  };

  console.log('Test 1: With filter UNREAD only (like your example)');
  await makeRequest("getItemsUnread", variables1);

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test 2: With both UNREAD and ARCHIVED
  const variables2 = {
    "filter": {"statuses": ["UNREAD", "ARCHIVED"]},
    "sort": {"sortBy": "CREATED_AT", "sortOrder": "DESC"},
    "pagination": {"first": 10}
  };

  console.log('\nTest 2: With both UNREAD and ARCHIVED + pagination');
  await makeRequest("getItemsUnread", variables2);
}

async function makeRequest(operationName, variables) {
  const postData = JSON.stringify({
    query: query,
    operationName: operationName,
    variables: variables
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData),
    'referer': 'https://getpocket.com/saves?src=navbar'
  });

  console.log('Operation:', operationName);
  console.log('Variables:', JSON.stringify(variables));

  const options = {
    hostname: 'getpocket.com',
    path: getGraphQLEndpoint(),
    method: 'POST',
    headers: headers
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.errors) {
            console.log('❌ Error:', JSON.stringify(response.errors[0]));
          } else if (response.data?.user?.savedItems) {
            const count = response.data.user.savedItems.edges?.length || 0;
            console.log(`✅ Success! Got ${count} items`);
          } else {
            console.log('Response:', JSON.stringify(response, null, 2));
          }
          resolve();
        } catch (e) {
          console.log('Parse error:', e.message);
          resolve();
        }
      });
    });
    
    req.on('error', (e) => {
      console.log('Request error:', e.message);
      resolve();
    });
    
    req.write(postData);
    req.end();
  });
}

testQuery().catch(console.error);
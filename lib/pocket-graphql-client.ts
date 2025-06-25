import https from 'https';

const { getHeaders, getGraphQLEndpoint, respectRateLimit, isRateLimitResponse, isAuthError, handleRateLimit, buildGraphQLQuery, CONSUMER_KEY } = require('../helpers');

const SAVED_ITEMS_QUERY = buildGraphQLQuery(`
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
              ...ItemDetails
              ... on Item {
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
`, ['SavedItemDetails', 'ItemDetails', 'ItemPreview']);

export async function fetchPocketArticlesGraphQL(
  cookieString: string,
  headers: Record<string, string>,
  cursor?: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const variables = {
      filter: { statuses: ["UNREAD", "ARCHIVED"] },
      sort: { sortBy: "CREATED_AT", sortOrder: "DESC" },
      pagination: cursor ? { after: cursor, first: 100 } : { first: 100 }
    };

    const postData = JSON.stringify({
      query: SAVED_ITEMS_QUERY,
      operationName: "GetSavedItems",
      variables: variables
    });

    const options = {
      hostname: 'getpocket.com',
      port: 443,
      path: getGraphQLEndpoint(),
      method: 'POST',
      headers: getHeaders({
        'cookie': cookieString,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData).toString(),
        ...headers
      })
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', async () => {
        try {
          const response = JSON.parse(data);
          
          // Check for authentication errors
          if (isAuthError(response)) {
            reject(new Error('Authentication failed - session expired'));
            return;
          }

          // Check for rate limit errors
          if (isRateLimitResponse(response)) {
            await handleRateLimit({ code: '161' });
            // Retry the request
            fetchPocketArticlesGraphQL(cookieString, headers, cursor)
              .then(resolve)
              .catch(reject);
            return;
          }

          resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}
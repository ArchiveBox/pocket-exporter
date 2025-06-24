#!/usr/bin/env node

const https = require('https');

// Exact fetch from user
const url = "https://getpocket.com/graphql?consumer_key=94110-6d5ff7a89d72c869766af0e0&enable_cors=1";
const headers = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.5",
  "apollographql-client-name": "web-client",
  "apollographql-client-version": "1.162.3",
  "cache-control": "no-cache",
  "content-type": "application/json",
  "pragma": "no-cache",
  "priority": "u=1, i",
  "sec-ch-ua": "\"Chromium\";v=\"136\", \"Brave\";v=\"136\", \"Not.A/Brand\";v=\"99\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"macOS\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-gpc": "1",
  "x-accept": "application/json; charset=UTF8",
  "cookie": "PHPSESSID=07cc156b7277f7c22f0f1dea76af9131; _omappvp=zlza45hD4VEpRuBBqMTMyqE54iUrtLNZw3oaPU46AcOLjzHQGbuMSaSB1ZhIh8wsym8j0F8lXYjnNqgwDP1vhZJsfGMkKuG7; a95b4b6=951T8Ae3gbsH5pc095d4c67d17p3giP8163q94H7aXT4d2Tb3c7e0t5dvb8qA4e1; d4a79ec=1186ca0d3e23eb64c4368ea251b9168c61d2a6db1426c4bcb47381e72f188376; 159e76e=c01c4ce49ecc17df0522b9cab59f130f2f96e3821a350dbeb1394495a8a96b26; sess_nonce=0.21458600+175079930419d612c72fc15f9cd2c8c3716ccb23767cd9f998; a_widget_t=e0e24362bf090a7f61fe442eebf077a470ff85e3; ps=0; ftv1=86b7ebc1-1d06-719a-f169-308c49; fsv1=8adc0e96e7145c5d52f7c589d7459a40dfc3be78; sess_guid=8aMp5T31AU149va215ga2cqE25d5nc4eW17Aq2w9byr9c5H81cp30QjSG6bSQdiP; _omappvs=1750800947162; AUTH_BEARER_default=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzUxMiJ9.eyJpYXQiOjE3NTA4MDA5NDcsImp0aSI6IlltMUkySVRRZUJZMGZTbDJWWTF5dmE2QldvbitHMnNiV3FiRmtUUnI3STA9IiwiaXNzIjoiZ2V0cG9ja2V0LmNvbSIsIm5iZiI6MTc1MDgwMDk0NywiZXhwIjoxNzUwODA0NTQ3LCJkYXRhIjoiX3NmMl9hdHRyaWJ1dGVzfGE6MTp7czoyMzpcIl9jc3JmXC9wb2NrZXRfY3NyZl90b2tlblwiO3M6NDM6XCI3SHQ0V21Qb1VVbkJGYTZjbFlmV0s0NU1iaWZJTG1SR1Zlc0lhNjNCaHAwXCI7fV9zZjJfbWV0YXxhOjM6e3M6MTpcInVcIjtpOjE3NTA4MDA5NDc7czoxOlwiY1wiO2k6MTc1MDc5NDA5ODtzOjE6XCJsXCI7czoxOlwiMFwiO30ifQ.I2-epwFCNJeMFfJjihSooA2aIrkEthUYsv6SWLtVFRt0Wft9jD0IyV17gdq3wmvzr-dPVKZeQs8sF6m4JzmT074ERpkQq8P-qogquXzpegx9OzTT6NPAmPXqCjJ-MSGeaX8f1aAw3knHEJ3mhMyrg_B2JXE_HiXypEaxdk-yQyP8a6Hkru9u0Pz-MozJiW314nDGcffUgs2t2fErw5Qs8m53z1aQ_2XzL4PasSWmO3PwHXoF_N6r4AT4IJ3qQurLE8v1c-8J6cppvOJekiuGNl7hq0gbHLJftoYV1YwPC13HFzN6NfCZbjlLrYLUScW0yu5AUvTrxu4oWo3f19b2dw",
  "Referer": "https://getpocket.com/saves?src=sidebar",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

const body = JSON.stringify({
  "query": "\n  query GetSavedItems(\n    $filter: SavedItemsFilter\n    $sort: SavedItemsSort\n    $pagination: PaginationInput\n  ) {\n    user {\n      savedItems(filter: $filter, sort: $sort, pagination: $pagination) {\n        edges {\n          cursor\n          node {\n            ...SavedItemDetails\n            item {\n              ... on Item {\n                isArticle\n                hasImage\n                hasVideo\n                timeToRead\n                shareId: id\n                itemId\n                givenUrl\n                preview {\n                  ...ItemPreview\n                }\n              }\n            }\n          }\n        }\n        pageInfo {\n          hasNextPage\n          hasPreviousPage\n          startCursor\n          endCursor\n        }\n        totalCount\n      }\n    }\n  }\n  \n  fragment SavedItemDetails on SavedItem {\n    _createdAt\n    _updatedAt\n    title\n    url\n    savedId: id\n    status\n    isFavorite\n    favoritedAt\n    isArchived\n    archivedAt\n    tags {\n      id\n      name\n    }\n    annotations {\n      highlights {\n        id\n        quote\n        patch\n        version\n        _createdAt\n        _updatedAt\n        note {\n          text\n          _createdAt\n          _updatedAt\n        }\n      }\n    }\n  }\n\n  \n  fragment ItemPreview on PocketMetadata {\n    ... on ItemSummary {\n      previewId: id\n      id\n      image {\n        caption\n        credit\n        url\n        cachedImages(imageOptions: [{ id: \"WebPImage\", fileType: WEBP, width: 640 }]) {\n          url\n          id\n        }\n      }\n      excerpt\n      title\n      authors {\n        name\n      }\n      domain {\n        name\n      }\n      datePublished\n      url\n    }\n    ... on OEmbed {\n      previewId: id\n      id\n      image {\n        caption\n        credit\n        url\n        cachedImages(imageOptions: [{ id: \"WebPImage\", fileType: WEBP, width: 640 }]) {\n          url\n          id\n        }\n      }\n      excerpt\n      title\n      authors {\n        name\n      }\n      domain {\n        name\n      }\n      datePublished\n      url\n      htmlEmbed\n      type\n    }\n  }\n\n",
  "operationName": "getItemsUnread",
  "variables": {
    "filter": {"statuses": ["UNREAD"]},
    "sort": {"sortBy": "CREATED_AT", "sortOrder": "DESC"}
  }
});

console.log('Testing exact fetch request...\n');

// Add content-length
headers['content-length'] = Buffer.byteLength(body);

const urlObj = new URL(url);
const options = {
  hostname: urlObj.hostname,
  path: urlObj.pathname + urlObj.search,
  method: 'POST',
  headers: headers
};

const req = https.request(options, (res) => {
  let data = '';
  
  console.log('Status:', res.statusCode);
  console.log('Headers:', res.headers);
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('\nResponse:', JSON.stringify(response, null, 2));
      
      if (response.data?.user?.savedItems) {
        console.log('\n✅ SUCCESS! Got savedItems');
        console.log('Total count:', response.data.user.savedItems.totalCount);
      }
    } catch (e) {
      console.error('Parse error:', e.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.write(body);
req.end();
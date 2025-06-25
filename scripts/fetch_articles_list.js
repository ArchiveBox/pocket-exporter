#!/usr/bin/env node

// This is a wrapper script to run the TypeScript fetch-articles-task
const { runFetchArticlesTask } = require('../lib/fetch-articles-task');

const sessionId = process.argv[2];

if (!sessionId) {
  console.error('Usage: node fetch_articles_list.js <sessionId>');
  process.exit(1);
}

// Run the task
runFetchArticlesTask(sessionId).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
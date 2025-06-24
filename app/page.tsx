"use client"

import { useState, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { ExternalLink, Copy, Search, Code, Download, CheckCircle, Clock, Globe, Tag, X, AlertCircle } from "lucide-react"

interface Article {
  id: string
  title: string
  url: string
  tags: string[]
  featured_image?: string
  added_at: string
  domain?: string
  excerpt?: string
  time_to_read?: number
}

interface ParsedRequest {
  cookies: Record<string, string>
  headers: Record<string, string>
  url: string
}

export default function PocketExportApp() {
  const [currentStep, setCurrentStep] = useState(1)
  const [fetchRequest, setFetchRequest] = useState("")
  const [parsedRequest, setParsedRequest] = useState<ParsedRequest | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [articles, setArticles] = useState<Article[]>([])
  const [exportProgress, setExportProgress] = useState(0)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [authData, setAuthData] = useState<{ cookieString: string; headers: Record<string, string> } | null>(null)
  const [filterQuery, setFilterQuery] = useState("")
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [rateLimitRetryAfter, setRateLimitRetryAfter] = useState<number | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentArticleCountRef = useRef(0)

  // Filter articles based on search query
  const filteredArticles = useMemo(() => {
    if (!filterQuery.trim()) {
      return articles;
    }

    const query = filterQuery.toLowerCase();
    return articles.filter(article => {
      // Search in title
      if (article.title.toLowerCase().includes(query)) {
        return true;
      }
      
      // Search in URL
      if (article.url.toLowerCase().includes(query)) {
        return true;
      }
      
      // Search in tags
      if (article.tags.some(tag => tag.toLowerCase().includes(query))) {
        return true;
      }
      
      return false;
    });
  }, [articles, filterQuery]);

  const steps = [
    {
      title: "Login to Pocket",
      description: "Open Pocket in a new tab and log in to your account",
      icon: <ExternalLink className="w-5 h-5" />,
    },
    {
      title: "Open Developer Tools",
      description: "Press F12 or right-click and select 'Inspect Element'",
      icon: <Code className="w-5 h-5" />,
    },
    {
      title: "Find GraphQL Request",
      description: "Go to Network tab, search for 'graphql', and find a request",
      icon: <Search className="w-5 h-5" />,
    },
    {
      title: "Copy Request",
      description: "Right-click the request and copy as 'fetch (Node.js)'",
      icon: <Copy className="w-5 h-5" />,
    },
    {
      title: "Paste & Export",
      description: "Paste the request below and start the export process",
      icon: <Download className="w-5 h-5" />,
    },
  ]

  const handleParseFetch = async () => {
    try {
      const response = await fetch('/api/parse-fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fetchCode: fetchRequest }),
      })

      const data = await response.json()

      if (data.success) {
        setAuthData(data.data)
        setParsedRequest({
          url: 'https://getpocket.com/graphql',
          headers: data.data.headers,
          cookies: data.data.cookies,
        })
        setCurrentStep(5)
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      alert('Failed to parse fetch request')
    }
  }

  const startExport = async () => {
    if (!authData) return

    setIsExporting(true)
    setExportProgress(0)
    setArticles([])
    currentArticleCountRef.current = 0

    try {
      // Start the export process
      const startResponse = await fetch('/api/export/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(authData),
      })

      const startData = await startResponse.json()

      if (!startData.success) {
        alert(`Error starting export: ${startData.error}`)
        setIsExporting(false)
        return
      }

      setSessionId(startData.sessionId)

      // Poll for status updates
      const interval = setInterval(async () => {
        try {
          const statusResponse = await fetch(
            `/api/export/status?sessionId=${startData.sessionId}&lastFetchedCount=${currentArticleCountRef.current}`
          )
          const statusData = await statusResponse.json()

          if (statusData.error && statusData.status !== 'error') {
            console.error('Export error:', statusData.error)
          }

          // Update progress
          setExportProgress(statusData.progress || 0)

          // Check for rate limiting
          if (statusData.status === 'rate-limited') {
            setIsRateLimited(true)
            setRateLimitRetryAfter(statusData.rateLimitRetryAfter || 60)
          } else if (isRateLimited && statusData.status === 'running') {
            // Rate limit has been lifted
            setIsRateLimited(false)
            setRateLimitRetryAfter(null)
          }

          // Add new articles
          if (statusData.newArticles && statusData.newArticles.length > 0) {
            setArticles((prev) => {
              // Create a map to track unique articles by ID
              const articleMap = new Map(prev.map(article => [article.id, article]))
              
              // Add new articles, overwriting any duplicates
              statusData.newArticles.forEach((article: Article) => {
                articleMap.set(article.id, article)
              })
              
              const updated = Array.from(articleMap.values())
              currentArticleCountRef.current = updated.length
              return updated
            })
          }

          // Check if export is complete
          if (statusData.status === 'completed') {
            clearInterval(interval)
            setIsExporting(false)
            setIsRateLimited(false)
            setRateLimitRetryAfter(null)
            setExportProgress(100)
            pollIntervalRef.current = null
          } else if (statusData.status === 'error') {
            clearInterval(interval)
            setIsExporting(false)
            setIsRateLimited(false)
            setRateLimitRetryAfter(null)
            pollIntervalRef.current = null
            alert(`Export failed: ${statusData.error}`)
          }
        } catch (error) {
          console.error('Status polling error:', error)
        }
      }, 2000) // Poll every 2 seconds
      
      pollIntervalRef.current = interval
    } catch (error) {
      console.error('Export error:', error)
      alert('Failed to start export')
      setIsExporting(false)
    }
  }

  // Cleanup interval on unmount
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Pocket Data Exporter</h1>
          <p className="text-lg text-gray-600">Export your saved articles from Mozilla Pocket</p>
        </div>

        {/* Steps Guide */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Export Process</CardTitle>
            <CardDescription>Follow these steps to export your Pocket data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {steps.map((step, index) => (
                <div key={index} className="flex items-start space-x-4">
                  <div
                    className={`flex items-center justify-center w-8 h-8 rounded-full ${
                      currentStep > index + 1
                        ? "bg-green-500 text-white"
                        : currentStep === index + 1
                          ? "bg-blue-500 text-white"
                          : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    {currentStep > index + 1 ? <CheckCircle className="w-4 h-4" /> : step.icon}
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-medium ${currentStep === index + 1 ? "text-blue-600" : "text-gray-900"}`}>
                      {step.title}
                    </h3>
                    <p className="text-sm text-gray-600">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Fetch Request Input */}
        {!parsedRequest && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Paste Your Fetch Request</CardTitle>
              <CardDescription>Paste the copied fetch request from your browser's developer tools</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="fetch('https://getpocket.com/graphql', {
  method: 'POST',
  headers: {
    'accept': '*/*',
    'content-type': 'application/json',
    'cookie': 'your-cookies-here',
    // ... other headers
  },
  body: JSON.stringify({...})
})"
                value={fetchRequest}
                onChange={(e) => setFetchRequest(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
              />
              <Button onClick={handleParseFetch} disabled={!fetchRequest.trim()} className="w-full">
                Parse Request
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Parsed Request Display */}
        {parsedRequest && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Parsed Request Data</CardTitle>
              <CardDescription>Extracted cookies and headers from your request</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">URL:</h4>
                <code className="block p-2 bg-gray-100 rounded text-sm break-all">{parsedRequest.url}</code>
              </div>

              <div>
                <h4 className="font-medium mb-2">Headers:</h4>
                <pre className="p-4 bg-gray-100 rounded text-sm overflow-auto max-h-40">
                  {JSON.stringify(parsedRequest.headers, null, 2)}
                </pre>
              </div>

              <div>
                <h4 className="font-medium mb-2">Cookies:</h4>
                <pre className="p-4 bg-gray-100 rounded text-sm overflow-auto max-h-40">
                  {JSON.stringify(parsedRequest.cookies, null, 2)}
                </pre>
              </div>

              <Button onClick={startExport} disabled={isExporting} className="w-full" size="lg">
                {isExporting ? "Fetching Articles..." : "Fetch Articles"}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Export Progress */}
        {isExporting && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Clock className="w-5 h-5" />
                <span>Export in Progress</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Progress value={exportProgress} className="w-full" />
              <p className="text-sm text-gray-600 mt-2">
                Fetching your articles... {exportProgress}% complete
                {articles.length > 0 && ` (${articles.length} articles fetched)`}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Rate Limit Warning */}
        {isRateLimited && (
          <Card className="mb-8 border-orange-200 bg-orange-50">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-orange-800">
                <AlertCircle className="w-5 h-5" />
                <span>Rate Limited</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-orange-700">
                Pocket API has temporarily rate limited our requests. The export will automatically resume in {rateLimitRetryAfter} seconds.
                Your {articles.length} fetched articles are safe and will continue to be displayed below.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Articles Grid */}
        {articles.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Your Articles ({articles.length})</CardTitle>
              <CardDescription>Your exported Pocket articles will appear here</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Filter Input */}
              <div className="mb-6">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    type="text"
                    placeholder="Filter by title, URL, or tags..."
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    className="pl-10 pr-10"
                  />
                  {filterQuery && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setFilterQuery("")}
                      className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {filterQuery && (
                  <p className="text-sm text-gray-600 mt-2">
                    Showing {filteredArticles.length} of {articles.length} articles
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredArticles.map((article) => (
                  <Card key={article.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                    <div className="aspect-video relative overflow-hidden bg-gray-100">
                      {article.featured_image && !failedImages.has(article.id) ? (
                        <img
                          src={article.featured_image}
                          alt={article.title}
                          className="w-full h-full object-cover"
                          onError={() => {
                            setFailedImages(prev => {
                              const newSet = new Set(prev)
                              newSet.add(article.id)
                              return newSet
                            })
                          }}
                        />
                      ) : (
                        <svg
                          className="w-full h-full"
                          viewBox="0 0 400 225"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <rect width="400" height="225" fill="#f3f4f6" />
                          <rect x="140" y="82.5" width="120" height="60" rx="4" fill="#e5e7eb" />
                          <path
                            d="M180 112.5L210 142.5L240 112.5"
                            stroke="#9ca3af"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <circle cx="230" cy="102.5" r="8" fill="#9ca3af" />
                        </svg>
                      )}
                    </div>
                    <CardContent className="p-4">
                      <h3 className="font-semibold text-lg mb-2 line-clamp-2">{article.title}</h3>

                      <div className="flex items-center space-x-2 text-sm text-gray-600 mb-3">
                        <Globe className="w-4 h-4" />
                        <span className="truncate">
                          {(() => {
                            try {
                              return new URL(article.url).hostname;
                            } catch {
                              return article.domain || 'Unknown domain';
                            }
                          })()}
                        </span>
                      </div>

                      {article.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {article.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-xs">
                              <Tag className="w-3 h-3 mr-1" />
                              {tag}
                            </Badge>
                          ))}
                          {article.tags.length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{article.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">{new Date(article.added_at).toLocaleDateString()}</span>
                        <Button size="sm" variant="outline" onClick={() => window.open(article.url, "_blank")}>
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {!isExporting && articles.length === 0 && !parsedRequest && (
          <Card className="text-center py-12">
            <CardContent>
              <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
                <Download className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Export</h3>
              <p className="text-gray-600">Follow the steps above to start exporting your Pocket articles</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
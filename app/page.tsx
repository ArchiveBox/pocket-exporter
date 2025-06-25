"use client"

import { useState, useRef, useMemo, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ExternalLink, Copy, Search, Code, Download, CheckCircle, Clock, Globe, Tag, X, AlertCircle, FileDown, ChevronDown, ChevronUp } from "lucide-react"
import { Article } from "@/types/article"
import { ArticleImage } from "@/components/article-image"
import { PaywallSection } from "@/components/PaywallSection"

interface ParsedRequest {
  cookies: Record<string, string>
  headers: Record<string, string>
  url: string
}

export default function PocketExportApp() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [currentStep, setCurrentStep] = useState(1)
  const [fetchRequest, setFetchRequest] = useState("")
  const [sessionData, setSessionData] = useState<any>(null)
  // Derived state from session data
  const parsedRequest = sessionData?.auth ? {
    url: 'https://getpocket.com/graphql',
    headers: sessionData.auth.headers || {},
    cookies: sessionData.auth.cookieString || {},
  } : null
  const authData = sessionData?.auth || null
  const fetchTask = sessionData?.currentFetchTask || { status: 'idle', count: 0, total: 0 }
  const downloadTask = sessionData?.currentDownloadTask || { status: 'idle', count: 0, total: 0 }
  const isExporting = fetchTask.status === 'running'
  const isDownloading = downloadTask.status === 'running'
  const isRateLimited = !!fetchTask.rateLimitedAt
  const rateLimitRetryAfter = fetchTask.rateLimitRetryAfter || null
  const isDownloadRateLimited = !!downloadTask.rateLimitedAt
  const downloadRateLimitRetryAfter = downloadTask.rateLimitRetryAfter || null
  const exportProgress = fetchTask.total > 0 ? Math.round((fetchTask.count / fetchTask.total) * 100) : 0
  const [articles, setArticles] = useState<Article[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState("")
  const [debouncedFilterQuery, setDebouncedFilterQuery] = useState("");
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [downloadStatus, setDownloadStatus] = useState<{ total: number; completed: number; downloading: number; errors: number; articleStatus: Record<string, 'pending' | 'downloading' | 'completed' | 'error'> } | null>(null)
  const [isParsedRequestCollapsed, setIsParsedRequestCollapsed] = useState(false)
  const [sessionSizeMB, setSessionSizeMB] = useState<number>(0)
  const [paymentData, setPaymentData] = useState<any>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentArticleCountRef = useRef(0)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const filterTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Check for existing session in URL on mount
  useEffect(() => {
    const urlSessionId = searchParams.get('session')
    if (urlSessionId && !sessionId) {
      setSessionId(urlSessionId)
    }
  }, [searchParams])

  // Update URL when session ID changes
  useEffect(() => {
    if (sessionId) {
      const params = new URLSearchParams(searchParams.toString())
      params.set('session', sessionId)
      router.push(`?${params.toString()}`)
    }
  }, [sessionId, router, searchParams])
  
  // Start polling on mount and whenever sessionId changes
  useEffect(() => {
    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    
    // Start polling if we have a sessionId
    if (sessionId) {
      startStatusPolling(sessionId)
    }
    
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [sessionId])

  // Handle filter input changes
  const handleFilterChange = useCallback(() => {
    if (filterTimeoutRef.current) {
      clearTimeout(filterTimeoutRef.current);
    }
    
    filterTimeoutRef.current = setTimeout(() => {
      const value = filterInputRef.current?.value || '';
      setDebouncedFilterQuery(value);
      setFilterQuery(value); // Keep this for the clear button and results count
    }, 300);
  }, []);

  // Filter articles based on search query
  const filteredArticles = useMemo(() => {
    if (!debouncedFilterQuery.trim()) {
      return articles;
    }

    const query = debouncedFilterQuery.toLowerCase();
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
      if (article.tags.some(tag => tag.name.toLowerCase().includes(query))) {
        return true;
      }
      
      return false;
    });
  }, [articles, debouncedFilterQuery]);

  const steps = useMemo(() => [
    {
      title: "Login to Pocket",
      description: "Open Pocket in a new tab and log in to your account",
      icon: <ExternalLink className="w-5 h-5" />,
      href: "https://getpocket.com/saves",
    },
    {
      title: "Open Developer Tools",
      description: "Press F12 or right-click and select 'Inspect Element'",
      icon: <Code className="w-5 h-5" />,
      href: "https://developer.chrome.com/docs/devtools/network",
    },
    {
      title: "Find GraphQL Request",
      description: "Go to the Network tab, click the record icon, refresh, then search for 'graphql' in the requests",
      icon: <Search className="w-5 h-5" />,
    },
    {
      title: "Copy Request",
      description: "Right-click any getpocket.com/graphql request and Copy as 'fetch (Node.js)'",
      icon: <Copy className="w-5 h-5" />,
    },
    {
      title: "Paste & Export",
      description: "Paste the request below and start the export process",
      icon: <Download className="w-5 h-5" />,
    },
  ], [])

  const savePocketAuth = async () => {
    try {
      const response = await fetch('/api/task/save-pocket-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fetchCode: fetchRequest }),
      })

      const data = await response.json()

      if (data.success) {
        setSessionId(data.sessionId)
        setCurrentStep(5)
        setIsParsedRequestCollapsed(true)
        // Clear the fetch request input
        setFetchRequest('')
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      alert('Failed to save authentication')
    }
  }

  const startStatusPolling = (sessionId: string) => {
    // Function to fetch status
    const fetchStatus = async () => {
      try {
        const statusResponse = await fetch(`/api/status?session=${sessionId}`)
        const statusData = await statusResponse.json()

        // Update the entire session data
        setSessionData(statusData)
        
        // Update download status - always update to reflect actual filesystem state
        if (statusData.downloadStatus) {
          setDownloadStatus(statusData.downloadStatus);
        }
        
        // Update session size
        if (typeof statusData.sessionSizeMB === 'number') {
          setSessionSizeMB(statusData.sessionSizeMB)
        }
        
        // Update payment data
        if (statusData.paymentData) {
          setPaymentData(statusData.paymentData);
        }

        // Update step when we have auth
        if (statusData.auth && currentStep < 5) {
          setCurrentStep(5)
          // Don't set collapsed state here - let user control it
        }

        // Update articles with the full list from the server
        if (statusData.articles) {
          setArticles(statusData.articles);
          currentArticleCountRef.current = statusData.articles.length;
        }
      } catch (error) {
        console.error('Status polling error:', error)
      }
    }
    
    // Immediately fetch once
    fetchStatus()
    
    // Then set up the interval
    const interval = setInterval(fetchStatus, 2000) // Poll every 2 seconds
    pollIntervalRef.current = interval
  }

  const startDownloadArticles = async () => {
    if (!sessionId || articles.length === 0) return

    try {
      const response = await fetch(`/api/task/download-articles/start?session=${sessionId}`, {
        method: 'POST'
      })
      
      const data = await response.json()
      
      if (!data.success && !data.alreadyRunning) {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      alert('Failed to start downloading articles')
    }
  }

  const stopFetchArticles = async () => {
    if (!sessionId) return

    try {
      const response = await fetch(`/api/task/fetch-articles-list/stop?session=${sessionId}`, {
        method: 'POST'
      })
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (!data.success) {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      console.error('Stop fetch error:', error)
      alert(`Failed to stop fetching articles: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const stopDownloadArticles = async () => {
    if (!sessionId) return

    try {
      const response = await fetch(`/api/task/download-articles/stop?session=${sessionId}`, {
        method: 'POST'
      })
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (!data.success) {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      console.error('Stop download error:', error)
      alert(`Failed to stop downloading articles: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const startFetchArticles = async () => {
    if (!sessionId) {
      alert('No session found. Please paste your fetch request first.')
      return
    }

    try {
      const response = await fetch(`/api/task/fetch-articles-list/start?session=${sessionId}`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!data.success && !data.alreadyRunning) {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      alert('Failed to start fetching articles')
    }
  }


  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
      if (filterTimeoutRef.current) {
        clearTimeout(filterTimeoutRef.current)
      }
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Pocket Data Exporter</h1>
          <p className="text-lg text-gray-600">Export your saved articles from Mozilla Pocket.<br/>Export all your bookmark URLs, titles, excerpts, tags, archived article text (for Pocket Premium users), and more...</p>
        </div>


        {/* Steps Guide */}
        {!sessionId && <Card className="mb-8">
            <CardHeader>
              <CardTitle>Export Process</CardTitle>
              <CardDescription>Follow these steps to export your Pocket data. Pocket provides no public API to export saved article text so we use your <a href="https://getpocket.com/saves" target="_blank" rel="noopener noreferrer">getpocket.com</a> login cookies to do the export.</CardDescription>
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
                      <a href={step.href || '#'} target={step.href ? "_blank" : "_self"} rel="noopener noreferrer">{step.title}</a>
                    </h3>
                    <p className="text-sm text-gray-600">{step.description}</p>
                  </div>
                </div>
              ))}
              <img src="/tutorial.jpg" alt="Pocket Authentication Tutorial" className="w-full h-auto" />
            </div>
          </CardContent>
        </Card> || ''}
  
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
              <Button onClick={savePocketAuth} disabled={!fetchRequest.trim()} className="w-full">
                Parse Request
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Parsed Request Display */}
        {parsedRequest && (
          <Card className="mb-8">
            <CardHeader 
              className="cursor-pointer"
              onClick={() => setIsParsedRequestCollapsed(!isParsedRequestCollapsed)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Pocket Authentication &nbsp; {parsedRequest.headers || ''}</CardTitle>
                  <CardDescription>
                    {isParsedRequestCollapsed 
                      ? "Click to expand and update authentication" 
                      : "Extracted cookies and headers from your request"}
                  </CardDescription>
                </div>
                <Button variant="ghost" size="sm">
                  {isParsedRequestCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </div>
            </CardHeader>
            {!isParsedRequestCollapsed && (
              <CardContent className="space-y-4">
              {sessionId && (
                <div className="mb-4 p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <p className="text-sm text-yellow-800 mb-2">
                    To the authentication link to Pocket, paste a fresh GraphQL Pocket request copied in <code>Fetch (node.js format)</code> from your browser's developer tools:
                  </p>
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Paste new fetch request here..."
                      value={fetchRequest}
                      onChange={(e) => setFetchRequest(e.target.value)}
                      className="min-h-[100px] font-mono text-sm"
                    />
                    <Button 
                      onClick={savePocketAuth} 
                      disabled={!fetchRequest.trim()} 
                      size="sm"
                      variant="outline"
                    >
                      Update Authentication
                    </Button>
                    <img src="/tutorial.jpg" alt="Pocket Authentication Tutorial" className="w-full h-auto" />
                  </div>
                </div>
              )}
              {!sessionId && (
                <Button onClick={startFetchArticles} disabled={isExporting} className="w-full" size="lg">
                  {isExporting ? "Fetching Articles..." : "Fetch Article List"}
                </Button>
              )}
            </CardContent>
            )}
          </Card>
        )}

        {/* Session Status / Resume Button */}
        <Card className="mb-8">
            <CardHeader>
              <CardTitle>Export Progress</CardTitle>
              <CardDescription>
                <div className="space-y-1">
                  {sessionId && <div>Session ID: {sessionId}</div>}
                  <div className="flex gap-4 text-sm">
                    <span>Articles pulled (metadata + text): <strong>{articles.length}</strong>{!paymentData?.hasUnlimitedAccess && articles.length >= 100 && <span className="text-orange-600"> (Free tier limit)</span>}</span>
                    <span>Original HTML downloaded: <strong>{downloadTask.count}/{articles.length}</strong></span>
                    <span>Total export size: <strong>{sessionSizeMB.toFixed(2)} MB</strong></span>
                  </div>
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Article Fetching Section */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Import from Pocket</h4>
                    {(isExporting || isRateLimited) && <Clock className="w-4 h-4 animate-pulse text-gray-500" />}
                  </div>
                  
                  {/* Article fetch progress bar */}
                  <Progress 
                    value={fetchTask.total > 0 ? (fetchTask.count / fetchTask.total) * 100 : 0} 
                    className={`w-full h-2 ${isRateLimited ? '[&>div]:bg-orange-500' : ''}`}
                  />
                  
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">
                      {fetchTask.status === 'running' || isRateLimited ? (
                        <>
                          Fetching articles... ({fetchTask.count}/{fetchTask.total > 0 ? (fetchTask.total > fetchTask.count ? `${fetchTask.total}+` : fetchTask.total) : '?'})
                          {isRateLimited && (
                            <span className="text-orange-600 font-medium">
                              {' '}(Rate limited - retrying in {rateLimitRetryAfter}s)
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          {articles.length} total articles
                          {fetchTask.status === 'completed' ? ' (completed)' :
                           fetchTask.status === 'stopped' ? ' (stopped by user)' :
                           fetchTask.status === 'error' ? ` (error: ${fetchTask.error})` : ''}
                        </>
                      )}
                    </span>
                    <Button 
                      onClick={isExporting || isRateLimited ? stopFetchArticles : startFetchArticles}
                      size="sm"
                      variant={isExporting || isRateLimited ? "destructive" : "default"}
                      disabled={!sessionId && !isExporting && !isRateLimited}
                      className={!isExporting && !isRateLimited && sessionId ? "bg-green-600 hover:bg-green-700 text-white animate-pulse shadow-lg shadow-green-600/25" : ""}
                    >
                      {isExporting || isRateLimited ? "Stop Fetching" : sessionId ? "Fetch Articles" : "Auth Required"}
                    </Button>
                  </div>
                </div>

                {/* Content Downloading Section */}
                {false && articles.length > 0 && (
                  <div className="space-y-3 pt-3 border-t">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium">Original HTML & Image Downloading &nbsp; <span className="text-orange-500">[BETA]</span> &nbsp; &nbsp; &nbsp; <small className="text-xs text-gray-500">(attempts to fetch live HTML from original URLs using curl)</small></h4>
                      {(isDownloading || isDownloadRateLimited) && 
                        <Clock className="w-4 h-4 animate-pulse text-gray-500" />
                      }
                    </div>
                    
                    {/* Content download progress bar */}
                    <Progress 
                      value={downloadTask.total > 0 
                        ? (downloadTask.count / downloadTask.total) * 100 
                        : 0} 
                      className={`w-full h-2 ${isDownloadRateLimited ? '[&>div]:bg-orange-500' : ''}`}
                    />
                    
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600">
                        {downloadTask.status === 'running' || isDownloadRateLimited ? (
                          <>
                            Downloading... ({downloadTask.count}/{downloadTask.total})
                            {isDownloadRateLimited && (
                              <span className="text-orange-600 font-medium">
                                {' '}(Rate limited - retrying in {downloadRateLimitRetryAfter}s)
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            {downloadTask.count > 0 
                              ? `${downloadTask.count}/${downloadTask.total} articles`
                              : `0/${articles.length} articles`}
                            {downloadTask.status === 'completed' ? ' (completed)' :
                             downloadTask.status === 'stopped' ? ' (stopped by user)' :
                             downloadTask.status === 'error' ? ` (error: ${downloadTask.error})` : ''}
                          </>
                        )}
                        {downloadStatus && downloadStatus.downloading > 0 && ` (${downloadStatus.downloading} in progress)`}
                        {downloadStatus && downloadStatus.errors > 0 && ` • ${downloadStatus.errors} errors`}
                      </span>
                      <Button 
                        onClick={isDownloading ? stopDownloadArticles : startDownloadArticles}
                        size="sm"
                        variant={isDownloading ? "destructive" : "default"}
                      >
                        {isDownloading ? "Stop HTML & Image Downloading" : "Download HTML & Images"}
                      </Button>
                    </div>
                  </div>
                )}

                {paymentData?.hasUnlimitedAccess && (
                  <div className="text-sm text-green-600 flex items-center gap-1 mt-1">
                    <CheckCircle className="w-3 h-3" />
                    {paymentData?.payment?.receiptUrl ? (
                      <a 
                        href={paymentData.payment.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        title="View payment receipt"
                      >
                        Purchased. Unlimited export enabled.
                      </a>
                    ) : (
                      <span>Purchased. Unlimited export enabled.</span>
                    )}
                    &nbsp;
                    <small className="text-xs text-gray-500">Contact <code>@ArchiveBoxApp</code> on X.com for support.</small>
                  </div>
                )}
                
                {/* Session URL */}
                {sessionId && (
                  <div className="p-3 bg-blue-50 rounded-lg border-t">
                    <p className="text-sm font-medium text-blue-900 mb-1">Visit this URL anytime to view live export progress</p>
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-white px-2 py-1 rounded flex-1 overflow-x-auto">
                        {typeof window !== 'undefined' ? window.location.origin : ''}{router ? `?session=${sessionId}` : ''}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const url = `${window.location.origin}?session=${sessionId}`;
                          navigator.clipboard.writeText(url);
                        }}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

        {/* Paywall Section - Show inline when payment is required */}
        {sessionId && fetchTask.error?.includes('Payment required') && !paymentData?.hasUnlimitedAccess && (
          <PaywallSection 
            sessionId={sessionId}
            articleCount={articles.length}
          />
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
        <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Your Articles ({articles.length})</CardTitle>
                  <CardDescription>
                    {articles.length === 0 
                      ? "Click 'Fetch Articles' to start importing your Pocket articles" 
                      : "Your exported Pocket articles"}
                  </CardDescription>
                </div>
                {sessionId && (
                  <div className="flex flex-col gap-2 items-end">
                    <div className="text-xs text-gray-500">
                      Session: <code className="bg-gray-100 px-1 rounded">{sessionId}</code>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const url = `${window.location.origin}?session=${sessionId}`;
                          navigator.clipboard.writeText(url);
                        }}
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy Link
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          window.open(`/api/session/json?session=${sessionId}`, '_blank')
                        }}
                      >
                        <FileDown className="w-4 h-4 mr-2" />
                        JSON ({articles.length})
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          window.open(`/api/session/zip?session=${sessionId}`, '_blank')
                        }}
                      >
                        <FileDown className="w-4 h-4 mr-2" />
                        ZIP ({articles.length})
                      </Button>
                    </div>
                    {exportProgress < 100 && (
                      <p className="text-xs text-gray-500 mt-1">Download includes {articles.length} articles fetched so far</p>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {/* Filter Input */}
              <div className="mb-6">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    ref={filterInputRef}
                    type="text"
                    placeholder="Filter by title, URL, or tags..."
                    defaultValue=""
                    onChange={handleFilterChange}
                    className="pl-10 pr-10"
                  />
                  {filterQuery && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (filterInputRef.current) {
                          filterInputRef.current.value = '';
                        }
                        setFilterQuery("");
                        setDebouncedFilterQuery("");
                      }}
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

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" style={{ contain: 'layout' }}>
                {filteredArticles.map((article) => {
                  const isCurrentlyDownloading = downloadTask.currentID === article.savedId;
                  return (
                    <Card 
                      key={article.savedId} 
                      className={`overflow-hidden hover:shadow-lg transition-all ${
                        isCurrentlyDownloading 
                          ? 'ring-2 ring-blue-500 shadow-blue-200 shadow-lg animate-pulse' 
                          : ''
                      }`}
                    >
                    <div className="aspect-video relative overflow-hidden bg-gray-100">
                      <ArticleImage 
                        article={article} 
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <CardContent className="p-3 pb-0">
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-semibold text-lg line-clamp-2 flex-1">{article.title}</h3>
                        <Avatar 
                          className="h-8 w-8 ml-2 cursor-pointer hover:opacity-80 transition-opacity" 
                          title={
                            downloadStatus?.articleStatus?.[article.savedId] === 'completed' 
                              ? 'Click to download HTML' 
                              : 'Click to download article content'
                          }
                          onClick={async () => {
                            if (downloadStatus?.articleStatus?.[article.savedId] === 'completed') {
                              // Download the HTML file
                              window.open(
                                `/api/article/html?session=${sessionId}&savedId=${article.savedId}`,
                                '_blank'
                              );
                            } else {
                              // Trigger download for this article
                              console.log(`Downloading single article: ${article.savedId}`);
                              try {
                                const response = await fetch(
                                  `/api/task/download-single/start?session=${sessionId}&articleId=${article.savedId}`,
                                  { method: 'POST' }
                                );
                                
                                const data = await response.json();
                                console.log('Download single response:', data);
                                
                                if (!response.ok) {
                                  alert(`Error: ${data.error}`);
                                } else {
                                  // If already downloaded, update status immediately
                                  if (data.alreadyDownloaded) {
                                    setDownloadStatus(prev => {
                                      if (!prev) return null;
                                      return {
                                        ...prev,
                                        articleStatus: {
                                          ...prev.articleStatus,
                                          [article.savedId]: 'completed'
                                        }
                                      };
                                    });
                                  }
                                  // Start polling if not already running
                                  if (!pollIntervalRef.current) {
                                    startStatusPolling(sessionId);
                                  }
                                }
                              } catch (error) {
                                console.error('Download single error:', error);
                                alert('Failed to start download');
                              }
                            }
                          }}
                        >
                          <AvatarFallback className={
                            downloadStatus?.articleStatus?.[article.savedId] === 'completed' 
                              ? "bg-green-100 text-green-700" 
                              : downloadStatus?.articleStatus?.[article.savedId] === 'downloading'
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                          }>
                            {downloadStatus?.articleStatus?.[article.savedId] === 'completed' 
                              ? '✓' 
                              : downloadStatus?.articleStatus?.[article.savedId] === 'downloading'
                              ? '⏬'
                              : '⏳'}
                          </AvatarFallback>
                        </Avatar>
                      </div>

                      <div className="flex items-center space-x-2 text-sm text-gray-600 mb-3">
                        <Globe className="w-4 h-4" />
                        <a className="truncate" href={article.url} rel="noopener noreferrer">
                          {(() => {
                            try {
                              return new URL(article.url).hostname;
                            } catch {
                              return article.item.domainMetadata?.name || 'Unknown domain';
                            }
                          })()}
                        </a>
                        <span className="text-xs text-gray-500 float-right">{new Date(article._createdAt * 1000).toLocaleDateString()}</span>
                      </div>

                      {article.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {article.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag.id} variant="secondary" className="text-xs">
                              <Tag className="w-3 h-3 mr-1" />
                              {tag.name}
                            </Badge>
                          ))}
                          {article.tags.length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{article.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}
                      
                      <div className="mt-2 pt-2 border-t mb-2" style={{textAlign: 'center'}}>
                        <a 
                          href={`https://getpocket.com/read/${article.item.readerSlug || article.savedId}`}
                          rel="noopener noreferrer"
                          className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                        >
                          <svg fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" className="icon" style={{height: '24px', display: 'inline-block'}}><path fillRule="evenodd" d="M1 4a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2 0v2h18V4z" clipRule="evenodd"></path><path fillRule="evenodd" d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zm2 10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8H5z" clipRule="evenodd"></path><path fillRule="evenodd" d="M15.707 11.293a1 1 0 0 1 0 1.414l-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 1 1 1.414-1.414L11 14.586l3.293-3.293a1 1 0 0 1 1.414 0" clipRule="evenodd"></path></svg> 
                          &nbsp;&nbsp;
                          Pocket ID: #<code>{article.savedId}</code>
                        </a>
                      </div>
                    </CardContent>
                  </Card>
                  )
                })}
              </div>
            </CardContent>
          </Card>

        {/* Empty State */}
        {!isExporting && articles.length === 0 && !parsedRequest && (
          <Card className="text-center py-12">
            <CardContent>
              <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
                <Download className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Export</h3>
              <p className="text-gray-600">Follow the steps above to start exporting your Pocket articles</p>
              {sessionId && (
                <p className="text-sm text-gray-500 mt-2">
                  Session ID: <code className="bg-gray-100 px-1 rounded">{sessionId}</code>
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

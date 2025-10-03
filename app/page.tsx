"use client"

import { useState, useRef, useMemo, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import React from "react"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ExternalLink, Copy, Search, Code, Download, CheckCircle, Clock, Globe, Tag, X, AlertCircle, FileDown, ChevronDown, ChevronUp, Trash2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Article } from "@/types/article"
import { ArticleImage } from "@/components/article-image"
// Paywall disabled - import commented out
// import { PaywallSection } from "@/components/PaywallSection"
import * as AccordionPrimitive from '@radix-ui/react-accordion';

interface ParsedRequest {
  cookies: Record<string, string>
  headers: Record<string, string>
  url: string
}

// Helper function to format dates
function formatDate(date: string | Date | null | undefined): string {
  if (!date) return 'Never';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid date';
  return d.toLocaleString();
}

// Separate component for countdown to avoid rerenders
const RateLimitCountdown = React.memo(({ nextRequestAvailable, isInSlowMode }: { nextRequestAvailable: string, isInSlowMode: boolean }) => {
  const [countdown, setCountdown] = useState<number | null>(null);
  
  useEffect(() => {
    const updateCountdown = () => {
      const now = Date.now();
      const nextTime = new Date(nextRequestAvailable).getTime();
      const diff = Math.max(0, nextTime - now);
      setCountdown(diff);
    };
    
    updateCountdown(); // Initial update
    const interval = setInterval(updateCountdown, 100); // Update every 100ms
    
    return () => clearInterval(interval);
  }, [nextRequestAvailable]);
  
  if (countdown === null) return null;
  
  const seconds = Math.floor(Math.abs(countdown) / 1000);
  const ms = Math.abs(countdown) % 1000;
  const isOverdue = countdown < 0;
  
  return (
    <span className={`text-xs ml-2 ${isOverdue ? 'text-red-600 font-medium' : isInSlowMode ? 'text-orange-600 font-medium' : 'text-gray-500'}`}>
      {isOverdue ? 'overdue by ' : 'next in '}{seconds}.{String(ms).padStart(3, '0')}s{isInSlowMode && ' - throttled'}
    </span>
  );
});

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
  const fetchTask = sessionData?.currentFetchTask || { status: 'idle', count: 0, total: 0, error: undefined }
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
  const [rateLimitStatus, setRateLimitStatus] = useState<any>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [isDownloadingZip, setIsDownloadingZip] = useState(false)
  const [hasReceivedFirstResponse, setHasReceivedFirstResponse] = useState(false)
  const ITEMS_PER_PAGE = 24 // 24 items per page for a nice grid
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentArticleCountRef = useRef(0)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const filterTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const sessionNotFoundRef = useRef(false)
  const statusRequestInFlightRef = useRef(false)
  const fetchStatusRef = useRef<() => Promise<void>>()

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
  
  // Define fetchStatus as a standalone function that can be called anytime
  const fetchStatus = useCallback(async () => {
    if (!sessionId) return
    
    // Don't fetch if session was already not found
    if (sessionNotFoundRef.current) {
      return
    }
    
    // Don't fetch if a request is already in flight
    if (statusRequestInFlightRef.current) {
      console.log('Status request already in flight, skipping...')
      return
    }
    
    try {
      // Mark that we're starting a request
      statusRequestInFlightRef.current = true
      
      // Always use pagination, pass filter to backend
      const params = new URLSearchParams({
        session: sessionId,
        page: currentPage.toString(),
        limit: ITEMS_PER_PAGE.toString()
      })
      if (debouncedFilterQuery) {
        params.set('filter', debouncedFilterQuery)
      }
      const statusResponse = await fetch(`/api/status?${params.toString()}`)
      
      // Check if session was not found
      if (statusResponse.status === 404) {
        console.log('Session not found, redirecting to homepage')
        sessionNotFoundRef.current = true
        
        // Stop polling immediately
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        
        // Clear all state
        setSessionId('')
        setArticles([])
        setSessionData(null)
        setDownloadStatus(null)
        setSessionSizeMB(0)
        setPaymentData(null)
        
        // Redirect to homepage
        router.push('/')
        return
      }
      
      const statusData = await statusResponse.json()

      // Mark that we've received the first response
      if (!hasReceivedFirstResponse) {
        setHasReceivedFirstResponse(true)
      }

      // Update the entire session data
      setSessionData(statusData)
      
      // Debug: Log fetch task status when it has an error
      if (statusData.currentFetchTask?.status === 'error') {
        console.log('Fetch task error detected:', statusData.currentFetchTask);
      }
      
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
      
      // Update rate limit status
      if (statusData.rateLimitStatus) {
        setRateLimitStatus(statusData.rateLimitStatus);
      }

      // Update step when we have auth
      if (statusData.auth && currentStep < 5) {
        setCurrentStep(5)
        // Don't set collapsed state here - let user control it
      }

      // Update articles with the current page from the server
      if (statusData.articles) {
        setArticles(statusData.articles);
        // Use totalArticleCount from the server instead of articles.length
        currentArticleCountRef.current = statusData.totalArticleCount || statusData.articles.length;
      }
    } catch (error) {
      console.error('Status polling error:', error)
    } finally {
      // Always clear the in-flight flag when done (success or error)
      statusRequestInFlightRef.current = false
    }
  }, [sessionId, currentPage, debouncedFilterQuery, hasReceivedFirstResponse, currentStep, router])
  
  // Store the latest fetchStatus in a ref so polling can use it
  useEffect(() => {
    fetchStatusRef.current = fetchStatus
  }, [fetchStatus])

  // Start polling on mount and whenever sessionId changes
  useEffect(() => {
    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    
    // Reset session not found flag when session changes
    sessionNotFoundRef.current = false
    
    // Reset first response flag when session changes
    setHasReceivedFirstResponse(false)
    
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
  }, [sessionId]) // Only depend on sessionId, not fetchStatus
  
  // Fetch when filter or page changes
  useEffect(() => {
    if (sessionId && hasReceivedFirstResponse) {
      fetchStatus()
    }
  }, [debouncedFilterQuery, currentPage, fetchStatus, sessionId, hasReceivedFirstResponse])

  // Automatically expand auth section when there's an authentication error
  useEffect(() => {
    if (fetchTask.status === 'error' && fetchTask.error === 'Authentication expired') {
      setIsParsedRequestCollapsed(false)
    }
  }, [fetchTask.status, fetchTask.error])

  // Handle filter input changes
  const handleFilterChange = useCallback(() => {
    if (filterTimeoutRef.current) {
      clearTimeout(filterTimeoutRef.current);
    }
    
    filterTimeoutRef.current = setTimeout(() => {
      const value = filterInputRef.current?.value || '';
      setDebouncedFilterQuery(value);
      setFilterQuery(value); // Keep this for the clear button and results count
      setCurrentPage(1); // Reset to first page when filtering
    }, 300);
  }, []);

  // Articles are already filtered and paginated by the server
  const paginatedArticles = articles;
  
  // Use filteredCount from sessionData for pagination calculations
  const filteredCount = sessionData?.filteredCount || sessionData?.totalArticleCount || 0;
  const totalPages = Math.ceil(filteredCount / ITEMS_PER_PAGE);
  
  // Ensure current page is valid when articles change
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(1);
    }
  }, [currentPage, totalPages]);

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

  const startStatusPolling = (sessionId: string) => {
    // Clear any existing interval first
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    
    // Immediately fetch once
    if (fetchStatusRef.current) {
      fetchStatusRef.current()
    }
    
    // Then set up the interval
    const interval = setInterval(() => {
      if (fetchStatusRef.current) {
        fetchStatusRef.current()
      }
    }, 3000) // Poll every 3 seconds
    pollIntervalRef.current = interval
  }

  const savePocketAuth = async () => {
    try {
      const response = await fetch('/api/task/save-pocket-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          fetchCode: fetchRequest,
          oldSessionId: sessionId  // Pass current session ID if updating
        }),
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

  const startDownloadArticles = async () => {
    if (!sessionId || (sessionData?.totalArticleCount || 0) === 0) return

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

  const deleteSession = async () => {
    if (!sessionId) return

    const confirmed = window.confirm(
      `Are you sure you want to delete this session?\n\nThis will permanently delete:\n• ${sessionData?.totalArticleCount || 0} articles\n• All downloaded content\n• Session authentication data\n\nYour payment status will be preserved.\n\nThis action cannot be undone.`
    )

    if (!confirmed) return

    try {
      const response = await fetch(`/api/session/delete?session=${sessionId}`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (data.success) {
        // Clear local state
        setSessionId(null)
        setSessionData(null)
        setArticles([])
        setDownloadStatus(null)
        setPaymentData(null)
        setCurrentStep(1)
        setFilterQuery("")
        setDebouncedFilterQuery("")
        
        // Clear URL
        router.push('/')
        
        alert('Session deleted successfully')
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (error) {
      alert('Failed to delete session')
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
          <h2 className="text-lg text-gray-600 mb-6">
            Export your saved bookmarks and article content from Mozilla Pocket before they shut down in October 2025.<br/>
            Export all your bookmark URLs, titles, excerpts, tags, ⭐️s, highlights, <b>archived article content</b> (for Pocket Premium users), and more...
            <br/>
          </h2>
          
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-4 max-w-2xl mx-auto">
            <i className="text-gray-400">Did you pay for Pocket Premium for years to get their "Permanent Library" feature?</i>
            <br/>
            ...<br/>
            Well now <b><a href="https://getpocket.com/farewell" className="text-blue-600 hover:text-blue-700 font-large">Pocket is shutting down in October 2025 and deleting all user data</a></b> and it turns out they never intended to let you export any of those articles you paid to capture.
            <br/>
            <i className="text-gray-400">Many old sites have dissapeared forever, but Pocket still wont give us their snapshots!</i><br/>
            <br/>
            I reverse engineered their app APIs and built this tool to export everything that they (inexplicably) leave out of their own CSV export format: tags, ⭐️'s, their preserved copy of the original article text, featured images & videos, authors, and all other metadata.
            <br/>
            <br/><br/>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
              <div className="text-center sm:text-left">
                <h3 className="text-lg font-semibold text-gray-900 mb-1">🎁 Free unlimited export</h3>
                <p className="text-gray-600">Export all your articles with no limits</p>
              </div>
              <div className="text-center sm:text-left">
                <h3 className="text-lg font-semibold text-gray-900 mb-1">💎 Unlimited articles</h3>
                <p className="text-gray-600">Export your entire Pocket library</p>
              </div>
            </div>
          </div>
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
              <img src="/tutorial2.jpg" alt="Pocket Authentication Tutorial New" className="w-full h-auto" />
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
                    To re-authenticate with Pocket, paste a fresh GraphQL Pocket request copied in <code>Fetch (node.js format)</code> from your browser's developer tools:
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
                    <span>Articles pulled (metadata + text): {sessionId && !hasReceivedFirstResponse ? (
                      <Loader2 className="w-4 h-4 inline animate-spin" />
                    ) : (
                      <><strong>{sessionData?.totalArticleCount || articles.length}</strong></>
                    )}</span>
                    <span title="click the 📸 icon on individual articles below to include their live images and HTML into the export (50MB limit per article)">Article images downloaded: {sessionId && !hasReceivedFirstResponse ? (
                      <Loader2 className="w-4 h-4 inline animate-spin" />
                    ) : (
                      <strong>{downloadStatus?.completed || 0}/{sessionData?.totalArticleCount || articles.length}</strong>
                    )}</span>
                    <span>Total export size: {sessionId && !hasReceivedFirstResponse ? (
                      <Loader2 className="w-4 h-4 inline animate-spin" />
                    ) : (
                      <strong>{sessionSizeMB.toFixed(2)} MB</strong>
                    )}</span>
                  </div>
                  {sessionData && (
                    <div className="flex gap-4 text-xs text-gray-500 mt-2">
                      <span>Session updated: {formatDate(sessionData.lastModifiedAt)}</span>
                    </div>
                  )}
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
                  
                  {/* Show error message if fetch task has error */}
                  {fetchTask.error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-red-800">Fetch Error</p>
                          <p className="text-sm text-red-700 mt-1">{fetchTask.error}</p>
                          {fetchTask.error === 'Authentication expired' && (
                            <p className="text-sm text-red-600 mt-2">
                              Please update your authentication by pasting a fresh request above.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* Article fetch progress bar */}
                  <Progress 
                    value={fetchTask.total > 0 ? (fetchTask.count / fetchTask.total) * 100 : 0} 
                    className={`w-full h-2 ${isRateLimited ? '[&>div]:bg-orange-500' : ''} ${fetchTask.error ? '[&>div]:bg-red-500' : ''}`}
                  />
                  
                  <div className="flex items-center justify-between text-sm">
                    <div>
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
                            {sessionData?.totalArticleCount || articles.length} total articles
                            {fetchTask.status === 'completed' ? ' (completed)' :
                             fetchTask.status === 'stopped' ? ' (stopped by user)' :
                             fetchTask.status === 'error' ? ` (error: ${fetchTask.error})` : ''}
                          </>
                        )}
                      </span>
                      {(fetchTask.startedAt || fetchTask.endedAt) && (
                        <div className="text-xs text-gray-500 mt-1">
                          {fetchTask.startedAt && <span>Started: {formatDate(fetchTask.startedAt)}</span>}
                          {fetchTask.startedAt && fetchTask.endedAt && ' • '}
                          {fetchTask.endedAt && <span>Ended: {formatDate(fetchTask.endedAt)}</span>}
                        </div>
                      )}
                    </div>
                    <Button 
                      onClick={isExporting || isRateLimited ? stopFetchArticles : startFetchArticles}
                      size="sm"
                      variant={isExporting || isRateLimited ? "destructive" : fetchTask.error === 'Authentication expired' ? "outline" : "default"}
                      disabled={(!sessionId && !isExporting && !isRateLimited) || (fetchTask.error === 'Authentication expired')}
                      className={!isExporting && !isRateLimited && sessionId && !fetchTask.error ? "bg-green-600 hover:bg-green-700 text-white animate-pulse shadow-lg shadow-green-600/25" : ""}
                    >
                      {isExporting || isRateLimited ? "Pause Fetching" : 
                       fetchTask.error === 'Authentication expired' ? "Fresh Pocket Auth Required" :
                       sessionId ? "Fetch Articles" : "Auth Required"}
                    </Button>
                  </div>
                </div>

                {/* Rate Limit Status - Always show */}
                <div className="space-y-2 pt-1 pb-2">
                  <div className="text-sm text-gray-600">
                    Requests in last hour: <strong className="text-orange-700">{rateLimitStatus?.requestsInLastHour || 0}</strong><strong>/100</strong>
                    {rateLimitStatus && rateLimitStatus.nextRequestAvailable && (
                      <>
                        <RateLimitCountdown 
                          nextRequestAvailable={rateLimitStatus.nextRequestAvailable} 
                          isInSlowMode={rateLimitStatus.isInSlowMode} 
                        />
                      </>
                    )}

                    <span className="text-xs text-gray-500" style={{float: 'right'}}><code>100 requests/hr</code> ✖️ <code>100 articles/request</code> 🟰 <code>10k articles/hr</code> rate limit imposed by Pocket API</span>
                  </div>
                </div>

                {/* Content Downloading Section */}
                {false && (sessionData?.totalArticleCount || 0) > 0 && (
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
                              : `0/${sessionData?.totalArticleCount || 0} articles`}
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
                  <div className="text-sm text-green-600 flex items-center flex-grow gap-1 mt-1">
                    <CheckCircle className="w-3 h-3" />
                    {paymentData?.payment?.receiptUrl ? (
                      <a 
                        href={paymentData.payment.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        title="View payment receipt"
                      >
                        Purchased. Unlimited exports enabled.
                      </a>
                    ) : (
                      <span>Purchased. Unlimited exports enabled.</span>
                    )}
                    &nbsp;
                    <small className="text-xs text-gray-500">Open a <a href="https://github.com/ArchiveBox/pocket-exporter/issues" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700">Github issue</a> if you need support.</small>
                  </div>
                )}
                
                {/* Session URL */}
                {sessionId && (
                  <div className="p-3 bg-blue-50 rounded-lg border-t">
                    <p className="text-sm font-medium text-blue-900 mb-1">Visit this URL anytime to view live export progress</p>
                    <div className="flex items-center gap-2 mb-2">
                      <code className="text-xs bg-white px-2 py-1 rounded flex-1 overflow-x-auto">
                        {typeof window !== 'undefined' ? window.location.origin : ''}/{router ? `?session=${sessionId}` : ''}
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
                    <div className="bg-yellow-100 border border-yellow-300 rounded p-2">
                      <p className="text-xs text-yellow-800 font-semibold mb-1">⚠️ IMPORTANT: DO NOT LOSE THIS URL</p>
                      <p className="text-xs text-yellow-700">
                        This URL is the only thing tied to your payment. Pocket can be re-authorized and the export can be continued/restarted from this page without requiring any additional payments.
                      </p>
                      <p className="text-xs text-yellow-700 mt-1">
                        If you go back to the homepage and put in a fresh GraphQL request, we have no way to link your existing payment and it will treat you as a new user.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

        {/* Paywall disabled - section commented out */}
        {/* {sessionId && fetchTask.error?.includes('Payment required') && !paymentData?.hasUnlimitedAccess && (
          <PaywallSection 
            sessionId={sessionId}
            articleCount={sessionData?.totalArticleCount || articles.length}
          />
        )} */}

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
                Your {sessionData?.totalArticleCount || articles.length} fetched articles are safe and will continue to be displayed below.
              </p>
            </CardContent>
          </Card>
        )}
        
        {/* Slow Mode Warning */}
        {!isRateLimited && rateLimitStatus?.isInSlowMode && (fetchTask.status === 'running' || fetchTask.status === 'idle') && (sessionData?.totalArticleCount || 0) > 0 && (
          <Card className="mb-8 border-blue-200 bg-orange-50">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-orange-800">
                <Clock className="w-5 h-5" />
                <span>Rate Limiting Active</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-orange-700">
                To avoid hitting Pocket's rate limits, 
                we're now limiting exports to ~10k articles per hour (~{rateLimitStatus.requestsInLastHour}/hr). This ensures your export completes without getting forcibly logged out by Pocket.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Articles Grid */}
        <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Your Articles {sessionId && !hasReceivedFirstResponse ? (
                    <Loader2 className="w-4 h-4 inline animate-spin ml-2" />
                  ) : (
                    <>({sessionData?.totalArticleCount || articles.length})</>
                  )}</CardTitle>
                  <CardDescription>
                    {(sessionData?.totalArticleCount || articles.length) === 0 
                      ? "Click 'Fetch Articles' to start importing your Pocket articles" 
                      : `Your exported Pocket articles${filterQuery ? ' (filtered)' : ''}`}
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
                        JSON {hasReceivedFirstResponse && `(${sessionData?.totalArticleCount || articles.length})`}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          window.open(`/api/session/zip?session=${sessionId}`, '_blank')
                        }}
                        title="Creates entire ZIP in memory before sending - may timeout on large exports (>10k articles)"
                      >
                        <FileDown className="w-4 h-4 mr-2" />
                        ZIP
                      </Button>
                      <Button
                        size="sm"
                        onClick={async () => {
                          setIsDownloadingZip(true);
                          try {
                            // Create an invisible anchor element to trigger download
                            const link = document.createElement('a');
                            link.href = `/api/session/zip-stream?session=${sessionId}`;
                            link.download = `pocket-export-${sessionId}.zip`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            
                            // Keep spinner for a few seconds to indicate processing
                            setTimeout(() => {
                              setIsDownloadingZip(false);
                            }, 3000);
                          } catch (error) {
                            console.error('Download error:', error);
                            setIsDownloadingZip(false);
                          }
                        }}
                        disabled={isDownloadingZip}
                        className="bg-green-600 hover:bg-green-700 text-white"
                        title="Streams ZIP data as it's created - recommended for all exports, especially large ones"
                      >
                        {isDownloadingZip ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Preparing...
                          </>
                        ) : (
                          <>
                            <FileDown className="w-4 h-4 mr-2" />
                            ZIP (stream)
                          </>
                        )}
                      </Button>
                    </div>
                    {exportProgress < 100 && (
                      <p className="text-xs text-gray-500 mt-1">Download includes {sessionData?.totalArticleCount || articles.length} articles fetched so far</p>
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
                        setCurrentPage(1);
                      }}
                      className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {filterQuery && sessionData && (
                  <p className="text-sm text-gray-600 mt-2">
                    Showing {sessionData.filteredCount} of {sessionData.totalArticleCount} articles
                    {totalPages > 1 && ` (page ${currentPage} of ${totalPages})`}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" style={{ contain: 'layout' }}>
                {paginatedArticles.map((article) => {
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
                              ? 'Click to view saved article text in a new tab' 
                              : 'Click to download live article HTML + images and include them in the export (50MB limit per article)'
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
                              : '📸'}
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
                          title="View article in Pocket"
                        >
                          <svg fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" className="icon" style={{height: '24px', display: 'inline-block'}}><path fillRule="evenodd" d="M1 4a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2 0v2h18V4z" clipRule="evenodd"></path><path fillRule="evenodd" d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zm2 10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8H5z" clipRule="evenodd"></path><path fillRule="evenodd" d="M15.707 11.293a1 1 0 0 1 0 1.414l-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 1 1 1.414-1.414L11 14.586l3.293-3.293a1 1 0 0 1 1.414 0" clipRule="evenodd"></path></svg> 
                          &nbsp;&nbsp;
                          Pocket ID: #<code>{article.savedId}</code>
                        </a>
                        {article.archivedotorg_url && (
                          <>
                            &nbsp;&nbsp;
                            <a
                              href={article.archivedotorg_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs hover:text-blue-600 transition-colors"
                              title="View on Archive.org"
                            >
                              🏛️
                            </a>
                          </>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  )
                })}
              </div>
              
              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6 pt-6 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  
                  <div className="flex items-center gap-1">
                    {/* Show first page */}
                    {currentPage > 3 && (
                      <>
                        <Button
                          variant={currentPage === 1 ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(1)}
                          className="w-10"
                        >
                          1
                        </Button>
                        {currentPage > 4 && <span className="px-1">...</span>}
                      </>
                    )}
                    
                    {/* Show current page and neighbors */}
                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                      .filter(page => {
                        const distance = Math.abs(page - currentPage);
                        return distance <= 2;
                      })
                      .map(page => (
                        <Button
                          key={page}
                          variant={currentPage === page ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(page)}
                          className="w-10"
                        >
                          {page}
                        </Button>
                      ))}
                    
                    {/* Show last page */}
                    {currentPage < totalPages - 2 && (
                      <>
                        {currentPage < totalPages - 3 && <span className="px-1">...</span>}
                        <Button
                          variant={currentPage === totalPages ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(totalPages)}
                          className="w-10"
                        >
                          {totalPages}
                        </Button>
                      </>
                    )}
                  </div>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  
                  <span className="ml-4 text-sm text-gray-600">
                    Page {currentPage} of {totalPages} ({filteredCount} articles{filterQuery ? ' filtered' : ''})
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

        {/* Empty State */}
        {!isExporting && (sessionData?.totalArticleCount || 0) === 0 && !parsedRequest && (
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

        {/* Delete Session Button */}
        {sessionId && (
          <div className="mt-8 text-center pb-8">
            <Button
              variant="destructive"
              size="lg"
              onClick={deleteSession}
              className="bg-red-600 hover:bg-red-700"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All Session Data
            </Button>
            <p className="text-xs text-gray-500 mt-2">
              This will permanently delete {sessionData?.totalArticleCount || 0} articles and their content + your Pocket credentials from our servers. It will not affect your data on Pocket or your payment status.
            </p>
          </div>
        )}

        <br/>
        <hr/>
        <div className="text-sm text-gray-500 pt-4 border-t">
          <a href="https://github.com/ArchiveBox/pocket-exporter" target="_blank" rel="noopener noreferrer" 
            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            Open source on Github
          </a>
          <small className="text-gray-500" style={{float: 'right'}}>
            Contact <a href="https://x.com/ArchiveBoxApp">X.com/ArchiveBoxApp</a> for questions or open a <a href="https://github.com/ArchiveBox/pocket-exporter/issues" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700">Github issue</a>.
          </small>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect, useRef } from "react"
import { Send, Settings, Trash2, Youtube, Sparkles, Loader2, PlayCircle, ArrowLeft } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import "./style.css" 

type Role = "user" | "assistant"
interface Message { role: Role; content: string }

export default function SidePanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false) 
  const [initLoading, setInitLoading] = useState(false) 
  const [videoProcessed, setVideoProcessed] = useState(false)
  const [currentVideoUrl, setCurrentVideoUrl] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [provider, setProvider] = useState("groq")

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  // 1. ADD THIS REF
  // This tracks the "real" current video, even inside async functions
  const activeUrlRef = useRef("") 

  // --- LOGIC: Load Chat & Settings ---
  const loadChatForUrl = (url: string) => {
    // Update the Ref immediately so any running async tasks know we switched context
    activeUrlRef.current = url; 

    // 1. Invalid or Non-YouTube URL? Reset everything.
    if (!url || !url.includes("youtube.com/watch")) {
        setVideoProcessed(false)
        setCurrentVideoUrl("")
        setMessages([])
        setInitLoading(false) // <--- CRITICAL RESET: Stop spinner immediately
        setLoading(false)     // <--- CRITICAL RESET
        return
    }

    // 2. Same video? Do nothing (prevents flickering)
    if (url === currentVideoUrl) return;

    // 3. New Video Detected: Set URL and Reset UI
    setCurrentVideoUrl(url)
    setMessages([]) 
    setVideoProcessed(false)
    
    // 4. CRITICAL: FORCE RESET LOADING STATES
    // This ensures if you switch tabs while one is loading, the new tab starts fresh
    setInitLoading(false) 
    setLoading(false)

    chrome.storage.local.get([url], (result) => {
        // Safety check: Ensure we are still looking at the requested URL
        if (activeUrlRef.current !== url) return; 

        if (result[url] && result[url].length > 0) {
            setMessages(result[url])
            setVideoProcessed(true) 
        } else {
            setMessages([])
            setVideoProcessed(false)
        }
    })
  }

  // --- MAIN LISTENER EFFECT ---
  useEffect(() => {
    // 1. Load saved user settings
    chrome.storage.local.get(["userApiKey", "userProvider"], (result) => {
        if(result.userApiKey) setApiKey(result.userApiKey)
        if(result.userProvider) setProvider(result.userProvider)
    })
    
    // 2. Initial Check
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url) loadChatForUrl(tabs[0].url)
    })
    
    // 3. Listener: Handle messages from background script
    const handleRuntimeMessage = (message: any) => {
        if (message.type === "TAB_CHANGED" || message.type === "URL_UPDATED") {
            console.log("🔄 Context Switch:", message.url)
            loadChatForUrl(message.url)
        }
    }

    // 4. Fallback Listener: Direct Tab Switching
    const handleTabChange = (activeInfo: any) => {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
            if (tab.url) loadChatForUrl(tab.url)
        })
    }

    // 5. Fallback Listener: Navigation within same tab
    const handleUrlUpdate = (tabId: number, changeInfo: any, tab: chrome.tabs.Tab) => {
        if (changeInfo.status === 'complete' && tab.active && tab.url) {
            loadChatForUrl(tab.url)
        }
    }

    // Register Listeners
    chrome.runtime.onMessage.addListener(handleRuntimeMessage)
    chrome.tabs.onActivated.addListener(handleTabChange)
    chrome.tabs.onUpdated.addListener(handleUrlUpdate)

    // Cleanup Listeners on Unmount
    return () => {
        chrome.runtime.onMessage.removeListener(handleRuntimeMessage)
        chrome.tabs.onActivated.removeListener(handleTabChange)
        chrome.tabs.onUpdated.removeListener(handleUrlUpdate)
    }
  }, [currentVideoUrl]) 

  // --- AUTO-SCROLL ---
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages, loading])
  
  // --- SAVE HISTORY TO STORAGE ---
  useEffect(() => { 
      if (currentVideoUrl && messages.length > 0) {
          chrome.storage.local.set({ [currentVideoUrl]: messages }) 
      }
  }, [messages, currentVideoUrl])

  // --- AUTO-RESIZE INPUT ---
  useEffect(() => {
    if (textareaRef.current) {
        textareaRef.current.style.height = "auto"
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [input])

  const saveSettings = () => {
      chrome.storage.local.set({ userApiKey: apiKey, userProvider: provider })
      setShowSettings(false)
  }

  // --- API: Initialize Chat ---
  const initChat = async () => {
    if (!currentVideoUrl) return
    
    // Capture the URL *at the moment the button was clicked*
    const targetUrl = currentVideoUrl; 
    
    setInitLoading(true) 
    try {
        const res = await fetch("http://127.0.0.1:8000/process-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ video_url: targetUrl }),
        })
        if (!res.ok) throw new Error("Backend Error")
        
        // 3. SAFETY CHECK:
        // Before updating UI, check: "Is the user STILL on this video?"
        if (activeUrlRef.current === targetUrl) {
            setVideoProcessed(true)
            setMessages([{ role: "assistant", content: "Ready! I've watched the video. Ask me anything!" }])
        } else {
            console.log("Background process finished, but user switched tabs. Ignoring UI update.")
        }

    } catch (e) { 
        console.error(e) 
    } finally { 
        // Only turn off loading if we are still on that tab.
        // If we switched tabs, we don't want to mess with the new tab's loading state.
        if (activeUrlRef.current === targetUrl) {
            setInitLoading(false) 
        }
    }
  }

  // --- API: Send Message ---
  const handleSend = async () => {
    if (!input.trim()) return
    const userMsg: Message = { role: "user", content: input }
    setMessages(prev => [...prev, userMsg])
    setInput("")
    setLoading(true)
    if (textareaRef.current) textareaRef.current.style.height = "auto"

    try {
      const res = await fetch("http://127.0.0.1:8000/chat", {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "x-api-key": apiKey,       
            "x-provider": provider
        },
        body: JSON.stringify({ 
            query: userMsg.content, 
            history: messages, 
            video_url: currentVideoUrl 
        }),
      })

      if (!res.ok) throw new Error("Failed")
      const data = await res.json()
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }])
    } catch (error) {
      setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ Error: Is the backend running?" }])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
      }
  }

  // --- VIEW: Settings ---
  if (showSettings) {
      return (
        <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans p-6">
            <div className="flex items-center gap-3 mb-8">
                <button onClick={() => setShowSettings(false)} className="p-2 -ml-2 hover:bg-slate-200 rounded-full transition">
                    <ArrowLeft size={20} className="text-slate-600"/>
                </button>
                <h1 className="font-bold text-xl text-slate-800">Configuration</h1>
            </div>
            <div className="space-y-6">
                <div className="space-y-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500">AI Provider</label>
                    <div className="relative">
                        <select 
                            value={provider} 
                            onChange={(e) => setProvider(e.target.value)} 
                            className="w-full p-4 border border-slate-200 rounded-xl bg-white text-slate-700 font-medium focus:ring-2 focus:ring-indigo-500 outline-none appearance-none"
                        >
                            <option value="groq">Groq (Fastest • Free)</option>
                            <option value="openai">OpenAI (GPT-4o)</option>
                            <option value="gemini">Google Gemini</option>
                        </select>
                    </div>
                </div>
                <div className="space-y-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500">API Key</label>
                    <input 
                        type="password" 
                        value={apiKey} 
                        onChange={(e) => setApiKey(e.target.value)} 
                        placeholder="sk-..." 
                        className="w-full p-4 border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-indigo-500 outline-none placeholder:text-slate-300" 
                    />
                </div>
                <button 
                    onClick={saveSettings} 
                    className="w-full bg-slate-900 text-white p-4 rounded-xl font-bold text-sm mt-4 hover:bg-slate-800 transition shadow-lg"
                >
                    Save Changes
                </button>
            </div>
        </div>
      )
  }

  // --- VIEW: Chat ---
  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans">
      
      {/* 1. HEADER */}
      <div className="px-4 py-3 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2">
            <div className="p-1.5 bg-red-50 rounded-lg">
                <Youtube size={20} className="text-red-600 fill-current" />
            </div>
            <h1 className="font-bold text-slate-800 text-sm tracking-tight">ChatTube</h1>
        </div>
        <div className="flex gap-1">
            <button 
                onClick={() => setShowSettings(true)} 
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
                title="Settings"
            >
                <Settings size={18} />
            </button>
            {messages.length > 0 && (
                <button 
                    onClick={() => { setMessages([]); chrome.storage.local.remove([currentVideoUrl]) }} 
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                    title="Clear Chat"
                >
                    <Trash2 size={18} />
                </button>
            )}
        </div>
      </div>

      {/* 2. CHAT AREA */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth">
        {!videoProcessed && messages.length === 0 ? (
           <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
              <div className="p-4 bg-white rounded-full shadow-lg shadow-slate-200/50 ring-1 ring-slate-100">
                  <PlayCircle size={40} className="text-indigo-600" />
              </div>
              <div className="space-y-2 max-w-[200px]">
                  <h3 className="font-bold text-slate-800">Ready to watch?</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">I can summarize this video or answer specific questions about it.</p>
              </div>
              
              {currentVideoUrl ? (
                  <button 
                    onClick={initChat} 
                    disabled={initLoading} 
                    className="group relative bg-slate-900 text-white px-6 py-3 rounded-xl font-semibold text-sm hover:bg-slate-800 transition shadow-xl shadow-slate-900/10 disabled:opacity-70 disabled:cursor-not-allowed overflow-hidden w-full max-w-[200px]"
                  >
                      <span className="relative flex items-center justify-center gap-2">
                        {initLoading ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                <span>Fetching Info...</span>
                            </>
                        ) : (
                            <>
                                <Sparkles size={16} />
                                <span>Start Chatting</span>
                            </>
                        )}
                      </span>
                  </button>
              ) : (
                  <div className="px-4 py-2 bg-orange-50 text-orange-600 text-xs font-medium rounded-lg border border-orange-100">
                      Open a YouTube video first
                  </div>
              )}
           </div>
        ) : (
            <>
                {messages.map((msg, index) => (
                    <div key={index} className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`flex gap-3 max-w-[85%] ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                            <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold shadow-sm ${
                                msg.role === "user" ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-indigo-600"
                            }`}>
                                {msg.role === "user" ? "You" : "AI"}
                            </div>
                            <div className={`p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                                msg.role === "user" ? "bg-indigo-600 text-white rounded-tr-sm" : "bg-white border border-slate-100 text-slate-700 rounded-tl-sm"
                            }`}>
                                 {msg.role === "assistant" ? (
                                    <ReactMarkdown 
                                        className="prose prose-sm max-w-none prose-p:text-slate-700 prose-headings:text-slate-900 prose-strong:text-slate-900 prose-ul:list-disc prose-ul:pl-4"
                                        remarkPlugins={[remarkGfm]}
                                    >
                                        {msg.content}
                                    </ReactMarkdown>
                                ) : (
                                    msg.content
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                
                {loading && (
                    <div className="flex w-full justify-start">
                        <div className="flex gap-3">
                            <div className="w-8 h-8 bg-white border border-slate-200 text-indigo-600 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold">AI</div>
                            <div className="bg-white p-4 rounded-2xl rounded-tl-sm border border-slate-100 shadow-sm">
                                <div className="flex gap-1">
                                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{animationDelay: '0ms'}}/>
                                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}}/>
                                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{animationDelay: '300ms'}}/>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} className="h-4" />
            </>
        )}
      </div>

      {/* 3. INPUT AREA */}
      {videoProcessed && (
        <div className="p-4 bg-white/80 backdrop-blur-md border-t border-slate-200 sticky bottom-0 z-20">
          <div className="relative flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-2xl p-1.5 focus-within:ring-2 focus-within:ring-indigo-100 focus-within:border-indigo-400 transition-all shadow-sm">
            <textarea 
                ref={textareaRef}
                className="w-full max-h-32 bg-transparent border-none text-sm text-slate-800 placeholder:text-slate-400 focus:ring-0 px-3 py-2.5 resize-none outline-none"
                placeholder="Ask a question..." 
                value={input} 
                onChange={(e) => setInput(e.target.value)} 
                onKeyDown={handleKeyDown}
                rows={1}
            />
            <button 
                onClick={handleSend} 
                disabled={loading || !input.trim()} 
                className="p-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 active:scale-95 transition-all shadow-md shadow-indigo-200 disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed mb-0.5 mr-0.5"
            >
                <Send size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
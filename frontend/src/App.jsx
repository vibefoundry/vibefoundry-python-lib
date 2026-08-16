import { useState, useEffect, useRef, useCallback } from 'react'
import FileTree from './components/FileTree'
import FileViewer from './components/FileViewer'
import FolderPicker from './components/FolderPicker'
import TemplatePickerModal from './components/TemplatePickerModal'
import DataPickerModal from './components/DataPickerModal'
import LogsModal from './components/LogsModal'
import { record, installErrorCapture } from './utils/diagnostics'
import {
  getFileType,
  getExtension
} from './utils/fileSystem'
import './App.css'

function App() {
  const [skipAuth, setSkipAuth] = useState(() => localStorage.getItem('vf_skip_auth') === '1')
  const [authStatus, setAuthStatus] = useState({ signedIn: false, loading: true })
  // Shown briefly after a fresh sign-in completes — gives the user a
  // confirmation moment before the IDE renders. Triggered by the
  // localStorage 'vf_signin_pending' flag set when startSignIn runs.
  const [showSignedInModal, setShowSignedInModal] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  // True when running EMBEDDED in a host pane rather than as the standalone app.
  // Host-neutral signals, any of which flips pane mode:
  //   - window.openai       -> Codex / ChatGPT desktop-app widget
  //   - framed (self!=top)  -> iframe embeds
  //   - ?pane=1             -> explicit marker for webview hosts (Claude Code's
  //                            preview is a NATIVE webview — not framed — and
  //                            forbids query strings in its config URLs, so the
  //                            marker arrives via a one-time navigation and is
  //                            REMEMBERED in this webview's own storage. Real
  //                            browsers have separate storage and never see it.)
  // Nothing else is needed to make a host feel native: the theme is already
  // neutral for everyone. This only hides chrome that cannot work in a pane.
  const clientIsPane = typeof window !== 'undefined' && (() => {
    if (window.openai || window.self !== window.top) return true
    if (new URLSearchParams(window.location.search).get('pane') === '1') {
      try { localStorage.setItem('vf_pane', '1') } catch { /* storage may be off */ }
      return true
    }
    try { return localStorage.getItem('vf_pane') === '1' } catch { return false }
  })()
  // The DETERMINISTIC signal: the backend says whether it is pane-hosted,
  // because the host plugin told it so in code at open time (POST /api/ui/pane).
  // Client-side signals above remain for hosts that provide them natively;
  // this one needs nothing from the URL, the webview, or the model.
  const [backendPane, setBackendPane] = useState(false)
  const isPane = clientIsPane || backendPane

  // Windows display scaling applies TWICE in embedded webviews — host window
  // scaled, webview scales again by devicePixelRatio — so every page renders
  // ~2x and pours off the right edge until a resize. Counter with 1/dpr,
  // Windows + embedded only: macOS renders correctly at its dpr, and a real
  // browser tab must keep native scaling. Ported from the legacy plugin's
  // 'display-scaling double-zoom' fix; composes with the user zoom control,
  // which scales a different element.
  useEffect(() => {
    const isWindows = /Windows/i.test(navigator.userAgent || '')
    const dpr = window.devicePixelRatio || 1
    if (isPane && isWindows && dpr > 1) {
      document.documentElement.style.zoom = String(1 / dpr)
    } else if (document.documentElement.style.zoom) {
      document.documentElement.style.zoom = ''
    }
  }, [isPane])

  // Read the version off the backend rather than hardcoding it here, so the
  // footer can't drift from the installed package the way it did before.
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data) return
        if (data.version) setAppVersion(data.version)
        if (data.pane_mode) setBackendPane(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Poll auth status every 2s so when the browser sign-in flow completes
  // and writes the token to disk, the IDE picks it up automatically.
  useEffect(() => {
    let cancelled = false
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/auth/status')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) {
          setAuthStatus({ ...data, loading: false })
          // If a sign-in flow was just kicked off and we're now signed in,
          // show the confirmation modal once and clear the pending flag.
          if (data.signedIn && localStorage.getItem('vf_signin_pending') === '1') {
            localStorage.removeItem('vf_signin_pending')
            setShowSignedInModal(true)
          }
        }
      } catch {
        if (!cancelled) setAuthStatus({ signedIn: false, loading: false })
      }
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleAuthToggle = async () => {
    if (authStatus.signedIn) {
      await fetch('/api/auth/sign-out', { method: 'POST' })
      setAuthStatus({ signedIn: false, loading: false })
    }
    localStorage.removeItem('vf_skip_auth')
    localStorage.removeItem('vf_signin_pending')
    setSkipAuth(false)
  }

  const startSignIn = async () => {
    const res = await fetch('/api/auth/start', { method: 'POST' })
    if (!res.ok) return
    const { url } = await res.json()
    // Mark that a sign-in is in flight; the auth-status poller picks this up
    // and shows the confirmation modal when status flips to signed-in.
    localStorage.setItem('vf_signin_pending', '1')
    window.open(url, '_blank', 'noopener')
  }

  const isSignedIn = authStatus.signedIn

  const [tree, setTree] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [folderName, setFolderName] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(320)
  const [isResizing, setIsResizing] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null) // 'saving', 'saved', 'error'
  const [showBuildModal, setShowBuildModal] = useState(false)
  const [isScaffolding, setIsScaffolding] = useState(false)
  const [showTemplatesMenu, setShowTemplatesMenu] = useState(false)
  const [showDataModal, setShowDataModal] = useState(false)
  const [dataCatalog, setDataCatalog] = useState(null)
  const [dataCatalogError, setDataCatalogError] = useState(null)
  const [loadingDataCatalog, setLoadingDataCatalog] = useState(false)
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadingId, setDownloadingId] = useState(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [deletedFileToast, setDeletedFileToast] = useState(null)
  // Starts CLOSED and is opened only if the backend turns out to have no folder
  // (see the /api/folder/info effect). Starting it open flashed the picker over
  // the IDE for the moment it took to ask.
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [projectPath, setProjectPath] = useState(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showToolsMenu, setShowToolsMenu] = useState(false)
  const toolsMenuRef = useRef(null)
  // In-app zoom, persisted per machine. Buttons are the reliable path; the
  // keyboard shortcut works wherever the host doesn't swallow it first.
  const [zoom, setZoomState] = useState(() => {
    const saved = parseInt(localStorage.getItem('vf_zoom'), 10)
    return saved >= 50 && saved <= 150 ? saved : 100
  })
  const setZoom = (v) => {
    const clamped = Math.min(150, Math.max(50, v))
    setZoomState(clamped)
    localStorage.setItem('vf_zoom', String(clamped))
  }
  const adjustZoom = (delta) => setZoom(zoom + delta)
  const [showNewFolderModal, setShowNewFolderModal] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

  const mainContentRef = useRef(null)
  const pollIntervalRef = useRef(null)
  const suppressAnimationsRef = useRef(false)
  const autoPreviewDebounceRef = useRef(null)
  const isAutoPreviewingRef = useRef(false)
  const templatesMenuRef = useRef(null)

  useEffect(() => {
    if (!showTemplatesMenu) return
    const handler = (e) => {
      if (templatesMenuRef.current && !templatesMenuRef.current.contains(e.target)) {
        setShowTemplatesMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showTemplatesMenu])

  // Sidebar resize handlers - use refs to avoid stale closures
  const isResizingRef = useRef(false)

  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    const handle = e.currentTarget
    const pointerId = e.pointerId
    // Pointer capture routes all subsequent pointer events to `handle` at the
    // browser dispatch level — works across iframes and the Chrome PDF plugin.
    try { handle.setPointerCapture(pointerId) } catch {}
    isResizingRef.current = true
    setIsResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      if (!isResizingRef.current) return
      ev.preventDefault()
      const newWidth = Math.max(200, Math.min(600, ev.clientX))
      setSidebarWidth(newWidth)
    }

    const onEnd = () => {
      isResizingRef.current = false
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { handle.releasePointerCapture(pointerId) } catch {}
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      handle.removeEventListener('lostpointercapture', onEnd)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('blur', onEnd)
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
    // Capture can be lost without any pointerup reaching the handle — the
    // pointer leaves an embedded webview's bounds, or the host app grabs it
    // for its own pane resize. Without these the drag never ends, and the
    // full-viewport .resize-capture-overlay latches on and eats every click,
    // which reads as a frozen IDE.
    handle.addEventListener('lostpointercapture', onEnd)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('blur', onEnd)
  }, [])

  // Helper to get a hash of the tree structure including modification times
  const getTreeHash = (nodes) => {
    const entries = []
    const collect = (items) => {
      for (const item of items) {
        entries.push(`${item.path}:${item.lastModified || 0}`)
        if (item.children) collect(item.children)
      }
    }
    collect(nodes)
    return entries.sort().join('|')
  }

  // Start polling for file changes
  useEffect(() => {
    if (!projectPath) return

    const poll = async () => {
      try {
        const res = await fetch('/api/files/tree')
        if (res.ok) {
          const data = await res.json()
          const newTree = data.tree

          // Show toast if files were deleted
          if (data.deletedFiles && data.deletedFiles.length > 0) {
            setDeletedFileToast({ filename: data.deletedFiles[0] })
            setTimeout(() => setDeletedFileToast(null), 3000)
          }

          setTree(prevTree => {
            const oldHash = getTreeHash(prevTree)
            const newHash = getTreeHash([newTree])
            if (oldHash !== newHash) {
              return [newTree]
            }
            return prevTree
          })
        }
      } catch (err) {
        console.error('Polling error:', err)
      }
    }

    pollIntervalRef.current = setInterval(poll, 2000)  // Reduced from 1s to improve PC performance

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [projectPath])

  // WebSocket for auto-preview of new output files (with debouncing + lock)
  useEffect(() => {
    if (!projectPath) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/watch`
    let ws = null
    let pendingFilePath = null // Track the latest file to load
    let reconnectTimeout = null
    let isMounted = true

    const loadOutputFile = async (filePath) => {
      // Skip if already loading or unmounted
      if (isAutoPreviewingRef.current || !isMounted) {
        pendingFilePath = filePath // Queue for later
        return
      }

      isAutoPreviewingRef.current = true
      const fileName = filePath.split('/').pop()
      setSelectedFile({ name: fileName, path: filePath })
      setLoading(true)

      try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
        if (res.ok) {
          const fileData = await res.json()
          if (fileData.type === 'dataframe') {
            setFileContent({
              type: 'dataframe',
              columns: fileData.columns,
              columnInfo: fileData.columnInfo,
              data: fileData.data,
              filename: fileData.filename,
              filePath: fileData.filePath,
              totalRows: fileData.totalRows,
              offset: fileData.offset,
              limit: fileData.limit
            })
          } else if (fileData.type === 'image') {
            // Image file - backend returns path for direct serving
            setFileContent({
              type: 'image',
              path: fileData.path,
              filename: fileData.filename,
              extension: fileData.extension
            })
          }
        }
      } catch (err) {
        console.error('Failed to load output file:', err)
      } finally {
        setLoading(false)
        isAutoPreviewingRef.current = false

        // If another file was queued while loading, load it after a delay
        if (pendingFilePath && pendingFilePath !== filePath && isMounted) {
          const nextFile = pendingFilePath
          pendingFilePath = null
          setTimeout(() => loadOutputFile(nextFile), 300)
        }
      }
    }

    // Collect files during debounce window, prioritize images over data files
    let pendingPreviewFiles = []
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp']
    const dataExts = ['csv', 'xlsx', 'xls']
    const allPreviewExts = [...imageExts, ...dataExts]

    const pickBestFile = (files) => {
      // Prioritize images over data files
      const images = files.filter(f => {
        const ext = f.split('.').pop()?.toLowerCase()
        return imageExts.includes(ext)
      })
      if (images.length > 0) return images[images.length - 1] // Latest image
      return files[files.length - 1] // Latest file
    }

    const connect = () => {
      if (!isMounted) return

      ws = new WebSocket(wsUrl)

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          // Bridge profile events to the LargeFilePreviewModal via custom event
          if (data.type === 'profile_progress' || data.type === 'profile_complete') {
            window.dispatchEvent(new MessageEvent('vf-ws-message', { data: event.data }))
          }
          if (data.type === 'output_file_change' && data.path) {
            const filePath = data.path
            const fileName = filePath.split('/').pop()

            // Auto-preview data files and images
            const ext = fileName.split('.').pop()?.toLowerCase()
            if (allPreviewExts.includes(ext)) {
              // Add to pending files
              if (!pendingPreviewFiles.includes(filePath)) {
                pendingPreviewFiles.push(filePath)
              }

              // Debounce: wait for all files, then pick the best one
              if (autoPreviewDebounceRef.current) {
                clearTimeout(autoPreviewDebounceRef.current)
              }
              autoPreviewDebounceRef.current = setTimeout(() => {
                autoPreviewDebounceRef.current = null
                const bestFile = pickBestFile(pendingPreviewFiles)
                pendingPreviewFiles = []
                loadOutputFile(bestFile)
              }, 1000) // Wait 1 second for things to settle
            }
          }
        } catch (e) {
          // Ignore parse errors for keepalive messages
        }
      }

      ws.onclose = () => {
        // Reconnect after delay (only if still mounted)
        if (isMounted) {
          reconnectTimeout = setTimeout(connect, 3000)
        }
      }
    }

    connect()

    return () => {
      isMounted = false
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      if (ws) ws.close()
      if (autoPreviewDebounceRef.current) {
        clearTimeout(autoPreviewDebounceRef.current)
      }
    }
  }, [projectPath])

  // Open folder picker
  const handleOpenFolder = () => {
    setShowFolderPicker(true)
  }

  // Handle folder selection from picker
  const handleFolderSelected = async (path) => {
    setShowFolderPicker(false)
    setLoading(true)

    // Clear existing polling
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    try {
      // Tell backend about the selected folder
      const selectRes = await fetch('/api/folder/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })

      if (!selectRes.ok) {
        throw new Error('Failed to select folder')
      }

      const selectData = await selectRes.json()
      setProjectPath(path)
      setFolderName(selectData.name || path.split('/').pop())
      setCanWrite(true)

      // Load the file tree
      const treeRes = await fetch('/api/files/tree')
      if (treeRes.ok) {
        const treeData = await treeRes.json()
        setTree([treeData.tree])
        // Show toast if files were deleted
        if (treeData.deletedFiles && treeData.deletedFiles.length > 0) {
          setDeletedFileToast({ filename: treeData.deletedFiles[0] })
          setTimeout(() => setDeletedFileToast(null), 3000)
        }
      }

      setSelectedFile(null)
      setFileContent(null)
    } catch (err) {
      console.error('Failed to open folder:', err)
    } finally {
      setLoading(false)
    }
  }

  // Open straight into the folder the backend was launched against.
  //
  // `vibefoundry <folder>` sets it at startup, and that is how the CLI, the
  // desktop pane and every host launch all start it — so the folder is already
  // decided by the time the UI loads and asking again is a question with one
  // right answer. The picker used to open regardless, which in a pane made
  // "which folder am I in?" the first thing you had to answer, and answered it
  // wrongly whenever the pane was talking to a backend on some other project.
  //
  // The picker still exists for the one case that needs it — a backend started
  // with no folder at all — and the Open Folder button still summons it.
  // Close the tools menu on any outside click, and honor Cmd/Ctrl +/-/0 for
  // zoom when the keystroke reaches us (in a browser it always does; in a host
  // pane the host usually eats it, which is why the buttons exist).
  useEffect(() => {
    const onClick = (e) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target)) setShowToolsMenu(false)
    }
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(10) }
      else if (e.key === '-') { e.preventDefault(); adjustZoom(-10) }
      else if (e.key === '0') { e.preventDefault(); setZoom(100) }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  })

  // Windows webviews can compute the FIRST layout against wrong viewport
  // metrics (DPI-scaling confusion) — everything centers off-screen until a
  // real resize forces a recompute. Nudge that recompute ourselves: a few
  // staggered forced reflows after first paint, harmless where metrics were
  // right all along. (The legacy plugin fought the same class of bug as
  // 'display-scaling double-zoom'.)
  useEffect(() => {
    const kick = () => {
      document.documentElement.style.minWidth = '100.0%'
      void document.documentElement.offsetWidth // force reflow
      document.documentElement.style.minWidth = ''
      window.dispatchEvent(new Event('resize'))
    }
    const timers = [100, 400, 1000, 2000].map(ms => setTimeout(kick, ms))
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    installErrorCapture()
    let cancelled = false

    // KEEP ASKING until a backend answers. One attempt is not enough in a pane:
    // the widget can render off a FAILED tool call (the host renders it off the
    // tool definition, success or not), and the real backend arrives seconds
    // later when a retried call launches it. Giving up on the first failure is
    // how the pane ended up stuck on a dead folder picker reading "Failed to
    // load home directory" while a perfectly good backend came up behind it.
    const deadline = Date.now() + 90 * 1000
    const boot = async () => {
      while (!cancelled) {
        try {
          const res = await fetch('/api/folder/info')
          if (res.ok) {
            const data = await res.json()
            // Recorded because "which folder did the IDE decide to open, and
            // where did that come from" is the first question worth asking
            // whenever the wrong project is on screen.
            record('boot.folder', { folder: (data && data.project_folder) || null })
            if (data && data.project_folder) {
              handleFolderSelected(data.project_folder)
            } else {
              // A live backend with no folder is the one case the picker is for.
              setShowFolderPicker(true)
            }
            return
          }
        } catch { /* backend not up yet; keep waiting */ }
        if (Date.now() > deadline) {
          record('boot.folder_timeout', {})
          setShowFolderPicker(true)
          return
        }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  const handleFileSelect = async (file) => {
    if (file.isDirectory) return

    setSelectedFile(file)
    setLoading(true)

    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(file.path)}`)
      if (res.ok) {
        const data = await res.json()

        // If file is too large, show the large file preview modal
        if (data.type === 'massive_file') {
          setFileContent({
            type: 'massive_file',
            filename: data.filename,
            filePath: data.filePath,
            fileSize: data.fileSize,
            columns: data.columns,
            totalRows: data.totalRows,
            hasProfile: data.hasProfile,
            columnDtypes: data.columnDtypes,
          })
        // If backend already parsed as dataframe, use directly
        } else if (data.type === 'dataframe') {
          setFileContent({
            type: 'dataframe',
            columns: data.columns,
            columnInfo: data.columnInfo,
            data: data.data,
            filename: data.filename,
            filePath: data.filePath,
            totalRows: data.totalRows,
            offset: data.offset,
            limit: data.limit,
            sheetNames: data.sheetNames || null,
            activeSheet: data.activeSheet || null
          })
        } else if (data.type === 'spreadsheet') {
          setFileContent({
            type: 'spreadsheet',
            path: data.path,
            filename: data.filename
          })
        } else if (data.type === 'docx') {
          setFileContent({
            type: 'docx',
            paragraphs: data.paragraphs,
            tables: data.tables,
            filename: data.filename
          })
        } else if (data.type === 'image') {
          // Image - backend returns path for direct serving
          setFileContent({
            type: 'image',
            path: data.path,
            filename: data.filename,
            extension: data.extension
          })
        } else if (data.type === 'json') {
          setFileContent({
            type: 'json',
            data: data.data,
            filename: data.filename
          })
        } else if (data.type === 'pdf') {
          setFileContent({
            type: 'pdf',
            path: data.path,
            filename: data.filename
          })
        } else {
          const fileType = getFileType(file.name)
          const extension = getExtension(file.name)
          setFileContent({
            type: fileType,
            content: data.content,
            filename: data.filename,
            extension,
            encoding: data.encoding
          })
        }
      } else {
        throw new Error('Failed to read file')
      }
    } catch (err) {
      console.error('Failed to read file:', err)
      setFileContent({ type: 'error', message: 'Failed to read file' })
    } finally {
      setLoading(false)
    }
  }

  // Switch Excel sheet
  const handleSheetChange = async (sheetName) => {
    if (!selectedFile?.path) return
    setLoading(true)
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(selectedFile.path)}&sheet=${encodeURIComponent(sheetName)}`)
      if (res.ok) {
        const data = await res.json()
        if (data.type === 'dataframe') {
          setFileContent({
            type: 'dataframe',
            columns: data.columns,
            columnInfo: data.columnInfo,
            data: data.data,
            filename: data.filename,
            filePath: data.filePath,
            totalRows: data.totalRows,
            offset: data.offset,
            limit: data.limit,
            sheetNames: data.sheetNames || null,
            activeSheet: data.activeSheet || null
          })
        }
      }
    } catch (err) {
      console.error('Failed to switch sheet:', err)
    } finally {
      setLoading(false)
    }
  }

  // Save file content
  const handleFileSave = useCallback(async (newContent) => {
    if (!selectedFile?.path || !canWrite) return

    // Suppress animations during save
    suppressAnimationsRef.current = true
    setSaveStatus('saving')
    try {
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile.path, content: newContent })
      })

      if (!res.ok) {
        throw new Error('Failed to save file')
      }

      setSaveStatus('saved')
      // Update fileContent to reflect saved state
      setFileContent(prev => ({ ...prev, content: newContent }))
      // Clear status and re-enable animations after delay
      setTimeout(() => {
        setSaveStatus(null)
        suppressAnimationsRef.current = false
      }, 2000)
    } catch (err) {
      console.error('Failed to save file:', err)
      setSaveStatus('error')
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }, [selectedFile, canWrite])

  // Refresh the file tree (called after file operations)
  const handleRefresh = useCallback(async () => {
    if (projectPath) {
      try {
        const res = await fetch('/api/files/tree')
        if (res.ok) {
          const data = await res.json()
          setTree([data.tree])
          // Show toast if files were deleted
          if (data.deletedFiles && data.deletedFiles.length > 0) {
            setDeletedFileToast({ filename: data.deletedFiles[0] })
            setTimeout(() => setDeletedFileToast(null), 3000)
          }
        }
      } catch (err) {
        console.error('Failed to refresh tree:', err)
      }
    }
  }, [projectPath])

  // Build project structure - creates folders and pulls templates via the proxy.
  // The backend reads the IDE auth token off disk (~/.vibefoundry/auth.json)
  // so the frontend doesn't need to pass anything.
  const handleBuildProject = async () => {
    if (!projectPath || !canWrite) return

    setIsScaffolding(true)
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        throw new Error('Build failed')
      }
      await handleRefresh()
      setShowBuildModal(false)
    } catch (err) {
      console.error('Failed to build project:', err)
    } finally {
      setIsScaffolding(false)
    }
  }

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true)
    setCatalogError(null)
    try {
      const res = await fetch('/api/templates/catalog')
      if (res.status === 401) {
        setCatalogError('Sign in to browse templates.')
        setCatalog(null)
        return
      }
      if (!res.ok) {
        throw new Error(`Catalog fetch failed (${res.status})`)
      }
      const data = await res.json()
      setCatalog(data)
    } catch (err) {
      console.error('Failed to load catalog:', err)
      setCatalogError('Could not load template catalog.')
      setCatalog(null)
    } finally {
      setLoadingCatalog(false)
    }
  }, [])

  const openDownloadModal = () => {
    setShowDownloadModal(true)
    loadCatalog()
  }

  const handleDownloadTemplate = async (templateId) => {
    if (!projectPath || !canWrite || isDownloading) return
    setIsDownloading(true)
    setDownloadingId(templateId)
    try {
      const res = await fetch('/api/templates/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId }),
      })
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`)
      }
      await handleRefresh()
      setShowDownloadModal(false)
    } catch (err) {
      console.error('Failed to download template:', err)
    } finally {
      setIsDownloading(false)
      setDownloadingId(null)
    }
  }

  const loadDataCatalog = useCallback(async () => {
    setLoadingDataCatalog(true)
    setDataCatalogError(null)
    setDataCatalog(null)
    try {
      const res = await fetch('/api/data/public/catalog')
      if (!res.ok) throw new Error(`Catalog fetch failed (${res.status})`)
      setDataCatalog(await res.json())
    } catch (err) {
      console.error('Failed to load data catalog:', err)
      setDataCatalogError('Could not load the public data catalog.')
    } finally {
      setLoadingDataCatalog(false)
    }
  }, [])

  const openDataModal = () => {
    setShowDataModal(true)
    loadDataCatalog()
  }

  const handleDeleteTemplates = async () => {
    if (!projectPath || !canWrite || isDeleting) return
    setIsDeleting(true)
    try {
      const res = await fetch('/api/templates', { method: 'DELETE' })
      if (!res.ok) {
        throw new Error(`Delete failed (${res.status})`)
      }
      await handleRefresh()
      setShowDeleteConfirm(false)
    } catch (err) {
      console.error('Failed to delete templates:', err)
    } finally {
      setIsDeleting(false)
    }
  }

  // Create new folder in project root
  const handleCreateNewFolder = async () => {
    if (!projectPath || !canWrite || !newFolderName.trim()) return

    setCreatingFolder(true)
    try {
      const res = await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: projectPath,
          name: newFolderName.trim()
        })
      })
      if (res.ok) {
        setNewFolderName('')
        setShowNewFolderModal(false)
        await handleRefresh()
      } else {
        const errData = await res.json()
        console.error('Failed to create folder:', errData.detail)
      }
    } catch (err) {
      console.error('Failed to create folder:', err)
    } finally {
      setCreatingFolder(false)
    }
  }

  // Helper to find a node by path in the tree
  const findNodeByPath = (nodes, targetPath) => {
    for (const node of nodes) {
      if (node.path === targetPath) return node
      if (node.children) {
        const found = findNodeByPath(node.children, targetPath)
        if (found) return found
      }
    }
    return null
  }

  // Handle file modifications - auto-refresh if viewing modified file
  const handleFilesModified = async (modifiedPaths) => {
    if (selectedFile && modifiedPaths.includes(selectedFile.path)) {
      try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(selectedFile.path)}`)
        if (res.ok) {
          const data = await res.json()
          if (data.type === 'dataframe') {
            setFileContent({
              type: 'dataframe',
              columns: data.columns,
              columnInfo: data.columnInfo,
              data: data.data,
              filename: data.filename,
              filePath: data.filePath,
              totalRows: data.totalRows,
              offset: data.offset,
              limit: data.limit
            })
          } else if (data.type === 'image') {
            setFileContent({
              type: 'image',
              path: data.path,
              filename: data.filename,
              extension: data.extension
            })
          } else if (data.type === 'pdf') {
            setFileContent({
              type: 'pdf',
              path: data.path,
              filename: data.filename
            })
          } else {
            const fileType = getFileType(selectedFile.name)
            const extension = getExtension(selectedFile.name)
            setFileContent({
              type: fileType,
              content: data.content,
              filename: data.filename,
              extension,
              encoding: data.encoding
            })
          }
        }
      } catch (err) {
        console.error('Failed to refresh file:', err)
      }
    }
  }

  const activeResizeCursor = isResizing ? 'col-resize' : null

  const renderSignInGate = () => (
    <div className="signin-screen">
      <div className="signin-card-custom">
        <div className="signin-card-banner">
          <img src="/vf_logo.png" alt="" className="signin-banner-logo" />
          <div className="signin-banner-title">VibeFoundry</div>
        </div>
        <div className="signin-card-body">
          <h2 className="signin-body-title">Sign In For VibeFoundry Premium</h2>
          <p className="signin-body-msg">
            We'll open a browser tab for you to sign in. Once done, you'll be
            returned here automatically.
          </p>
          <button className="signin-button" onClick={startSignIn}>
            Sign in to VibeFoundry
          </button>
        </div>
      </div>
      <button
        className="signin-skip"
        onClick={() => {
          localStorage.setItem('vf_skip_auth', '1')
          setSkipAuth(true)
        }}
      >
        Continue without signing in →
      </button>
      <p className="signin-skip-note">Free version. Some templates and features will be limited.</p>
    </div>
  )

  // The brand moment: a centered logo while the app is still finding its
  // backend/folder, instead of a blank pane or a bare "Open Folder" corner.
  // It yields to the IDE on its own the instant a folder lands — no gate, no
  // click. Shown only before a project exists and while no picker is up.
  const bootSplash = !projectPath && !showFolderPicker && (
    <div className="boot-splash">
      <img src="/vf_logo.png" alt="VibeFoundry" className="boot-splash-logo" />
    </div>
  )

  const ideContent = (
    <div
      className={`app ${isResizing ? 'resizing' : ''}`}
      // Percentage sizes self-compensate under CSS zoom in Chromium — they
      // resolve against the parent and render back to its true size — while
      // viewport units (the old height:100vh) scale with the zoom and shrank
      // the IDE. So: plain 100%. (An explicit inverse compensation on top of
      // percentages double-corrects and overflows the bottom.)
      style={{ zoom: zoom / 100, width: '100%', height: '100%' }}
    >
      {bootSplash}
      {activeResizeCursor && (
        <div className="resize-capture-overlay" style={{ cursor: activeResizeCursor }} />
      )}
      {/* Unified Top Bar */}
      {canWrite && tree.length > 0 && (
        <div className="top-bar">
          <div className="top-bar-section top-bar-left" style={{ width: sidebarWidth }}>
            <span className="top-bar-title">{folderName || 'Project'}</span>
            <button className="btn-flat" onClick={() => setShowBuildModal(true)}>
              Build
            </button>
            <div className="templates-menu-wrap" ref={templatesMenuRef}>
              <button
                className="btn-flat"
                onClick={() => setShowTemplatesMenu((v) => !v)}
                disabled={!projectPath || !canWrite}
                aria-haspopup="menu"
                aria-expanded={showTemplatesMenu}
              >
                Templates <span className="templates-menu-caret">▾</span>
              </button>
              {showTemplatesMenu && (
                <div className="templates-menu" role="menu">
                  <button
                    className="templates-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShowTemplatesMenu(false)
                      openDownloadModal()
                    }}
                  >
                    Download templates…
                  </button>
                  <button
                    className="templates-menu-item danger"
                    role="menuitem"
                    onClick={() => {
                      setShowTemplatesMenu(false)
                      setShowDeleteConfirm(true)
                    }}
                  >
                    Delete templates folder…
                  </button>
                </div>
              )}
            </div>
            <button
              className="btn-flat"
              onClick={openDataModal}
              disabled={!projectPath || !canWrite}
            >
              Public Data
            </button>
          </div>
          <div className="top-bar-section top-bar-center" />
          <div className="top-bar-section top-bar-right">
            {/* Zoom lives in the app because embeds can't have it any other
                way: inside a host pane Cmd+/- belongs to the HOST app and
                scales its whole window — the IDE never sees the keystroke. */}
            <div className="zoom-control">
              <button className="btn-flat zoom-btn" onClick={() => adjustZoom(-10)} aria-label="Zoom out">−</button>
              <button className="btn-flat zoom-btn zoom-value" onClick={() => setZoom(100)} title="Reset zoom">{zoom}%</button>
              <button className="btn-flat zoom-btn" onClick={() => adjustZoom(10)} aria-label="Zoom in">+</button>
            </div>
            {/* One menu instead of five buttons: Terminal/Claude/Codex/Gemini
                crowded the bar. The native-terminal entries still vanish in a
                pane (they open desktop windows a pane can't reach); Logs stays
                in every context — it's the only diagnostics a pane has. */}
            <div className="tools-menu" ref={toolsMenuRef}>
              <button className="btn-flat" onClick={() => setShowToolsMenu(v => !v)}>
                Tools ▾
              </button>
              {showToolsMenu && (
                <div className="tools-menu-list">
                  {!isPane && ['Terminal', 'Claude', 'Codex', 'Gemini'].map(label => (
                    <button
                      key={label}
                      className="tools-menu-item"
                      onClick={async () => {
                        setShowToolsMenu(false)
                        try {
                          await fetch('/api/terminal/launch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(
                              label === 'Terminal'
                                ? { path: projectPath }
                                : { path: projectPath, command: label.toLowerCase() }
                            )
                          })
                        } catch (err) {
                          console.error(`Failed to launch ${label}:`, err)
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="tools-menu-item"
                    onClick={() => { setShowToolsMenu(false); setShowLogs(true) }}
                  >
                    Logs
                  </button>
                </div>
              )}
            </div>
            <button className="btn-flat btn-auth" onClick={handleAuthToggle}>
              {isSignedIn ? 'Sign out' : 'Sign in'}
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="main-area">
        <div className={`sidebar ${isResizing ? 'resizing' : ''}`} style={{ width: sidebarWidth }}>
          <div className="file-tree-container">
            {tree.length > 0 ? (
              <FileTree
                tree={tree}
                onFileSelect={handleFileSelect}
                selectedPath={selectedFile?.path}
                onFilesModified={handleFilesModified}
                canWrite={canWrite}
                onRefresh={handleRefresh}
                suppressAnimationsRef={suppressAnimationsRef}
                projectPath={projectPath}
              />
            ) : (
              <div className="tree-placeholder">
                <button className="open-folder-btn" onClick={handleOpenFolder}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3H14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H2.5a2 2 0 0 1-2-2V3.87z"/>
                  </svg>
                  Open Folder
                </button>
              </div>
            )}
          </div>
          <div className="resize-handle" onPointerDown={handleResizeStart} />
        </div>

        <div className="main-content" ref={mainContentRef}>
          {/* Data File Deleted Toast - centered in main content */}
          {deletedFileToast && (
            <div className="deleted-file-toast">
              <div className="toast-title">Raw Data Shall Not Pass!</div>
              <div className="toast-icon">🛡️</div>
              <div className="toast-filename">{deletedFileToast.filename} - Deleted</div>
            </div>
          )}

          {loading ? (
            <div className="loading">Loading...</div>
          ) : fileContent ? (
            <FileViewer
              content={fileContent}
              canWrite={canWrite && !!selectedFile?.path}
              onSave={handleFileSave}
              onSheetChange={handleSheetChange}
              saveStatus={saveStatus}
              onLargeFilePreviewReady={(data) => {
                setFileContent({
                  type: 'dataframe',
                  columns: data.columns,
                  columnInfo: data.columnInfo,
                  data: data.data,
                  filename: data.filename,
                  filePath: data.filePath,
                  totalRows: data.totalRows,
                  offset: data.offset,
                  limit: data.limit,
                })
              }}
              onLargeFileCancel={() => {
                setFileContent(null)
                setSelectedFile(null)
              }}
              onShowData={async () => {
                // Re-read with the styled view suppressed, to get the sortable,
                // virtualized grid for working with the numbers.
                if (!selectedFile) return
                try {
                  const res = await fetch(
                    `/api/files/read?path=${encodeURIComponent(selectedFile.path)}&asData=1`
                  )
                  if (res.ok) setFileContent(await res.json())
                } catch (err) {
                  console.error('Failed to load data view:', err)
                }
              }}
            />
          ) : (
            <div className="placeholder">
              <div className="placeholder-content">
                <svg className="placeholder-icon" width="48" height="48" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3H14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H2.5a2 2 0 0 1-2-2V3.87z"/>
                </svg>
                <p className="placeholder-title">Select a file</p>
              </div>
            </div>
          )}
        </div>

      </div>

      {showBuildModal && (
        <div className="modal-overlay" onClick={() => !isScaffolding && setShowBuildModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Build Project</h3>
              <button className="modal-close" onClick={() => !isScaffolding && setShowBuildModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>This will create the VibeFoundry project structure:</p>
              <ul className="folder-list">
                <li>input_folder/</li>
                <li>output_folder/</li>
                <li>app_folder/ (scripts, meta_data)</li>
              </ul>
              <p className="modal-note">Skip this if your project is already set up.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowBuildModal(false)} disabled={isScaffolding}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleBuildProject} disabled={isScaffolding}>
                {isScaffolding ? 'Building...' : 'Build'}
              </button>
            </div>
          </div>
        </div>
      )}

      <TemplatePickerModal
        open={showDownloadModal}
        catalog={catalog}
        catalogError={catalogError}
        loadingCatalog={loadingCatalog}
        isDownloading={isDownloading}
        downloadingId={downloadingId}
        onSelect={handleDownloadTemplate}
        onClose={() => setShowDownloadModal(false)}
      />

      <DataPickerModal
        open={showDataModal}
        catalog={dataCatalog}
        catalogError={dataCatalogError}
        loadingCatalog={loadingDataCatalog}
        onSaved={handleRefresh}
        onClose={() => setShowDataModal(false)}
      />

      {showDeleteConfirm && (
        <div
          className="dialog-overlay"
          onClick={() => !isDeleting && setShowDeleteConfirm(false)}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete templates folder?</h3>
            <p>
              This will remove the entire <strong>templates/</strong> folder,
              including every downloaded template.
            </p>
            <p className="dialog-warning">
              Anything you customized inside <strong>templates/</strong> will be lost.
            </p>
            <div className="dialog-actions">
              <button
                className="dialog-btn cancel"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="dialog-btn danger"
                onClick={handleDeleteTemplates}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSignedInModal && (
        <div className="modal-overlay" onClick={() => setShowSignedInModal(false)}>
          <div className="modal signed-in-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Signed In!</h3>
            </div>
            <div className="modal-body">
              <p>You're signed in to VibeFoundry. Click below to continue into the IDE.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setShowSignedInModal(false)} autoFocus>
                Click Here to Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {showFolderPicker && (
        <FolderPicker
          onSelect={handleFolderSelected}
          onCancel={projectPath ? () => setShowFolderPicker(false) : undefined}
        />
      )}

      {/* The top bar (and its Logs button) only exists once a project is open —
          which means the one state where diagnostics matter most, nothing
          loading at all, had no way to reach them. Float one when the bar is
          absent so Logs is reachable from every state, including total failure. */}
      {!(canWrite && tree.length > 0) && (
        <button
          className="btn-flat"
          onClick={() => setShowLogs(true)}
          style={{
            position: 'fixed',
            top: '10px',
            right: '12px',
            zIndex: 1200,
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
          }}
        >
          Logs
        </button>
      )}

      {showLogs && <LogsModal onClose={() => setShowLogs(false)} />}

      {showNewFolderModal && (
        <div className="modal-overlay" onClick={() => !creatingFolder && setShowNewFolderModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>New Folder</h3>
              <button className="modal-close" onClick={() => !creatingFolder && setShowNewFolderModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>Create a new folder in the project root:</p>
              <input
                type="text"
                className="dialog-input"
                placeholder="Folder name..."
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFolderName.trim()) {
                    handleCreateNewFolder()
                  } else if (e.key === 'Escape') {
                    setShowNewFolderModal(false)
                    setNewFolderName('')
                  }
                }}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => { setShowNewFolderModal(false); setNewFolderName('') }} disabled={creatingFolder}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleCreateNewFolder} disabled={creatingFolder || !newFolderName.trim()}>
                {creatingFolder ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Bar */}
      {canWrite && tree.length > 0 && (
        <div className="bottom-bar">
          <span className="bottom-bar-text">
            VibeFoundry IDE{appVersion ? ` v${appVersion}` : ''}
          </span>
        </div>
      )}

    </div>
  )

  if (skipAuth) return ideContent
  // Even the auth check gets the logo rather than a blank frame.
  if (authStatus.loading) return (
    <div className="boot-splash">
      <img src="/vf_logo.png" alt="VibeFoundry" className="boot-splash-logo" />
    </div>
  )
  if (authStatus.signedIn) return ideContent
  return renderSignInGate()
}

export default App

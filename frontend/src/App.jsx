import { useState, useEffect, useRef, useCallback } from 'react'
import FileTree from './components/FileTree'
import FileViewer from './components/FileViewer'
import FolderPicker from './components/FolderPicker'
import TemplatePickerModal from './components/TemplatePickerModal'
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
  // Three host-neutral signals, any of which flips pane mode:
  //   - window.openai       -> Codex / ChatGPT desktop-app widget
  //   - framed (self!=top)  -> Claude Code preview (and any iframe embed)
  //   - ?pane=1             -> explicit override for testing / custom launches
  // Nothing else is needed to make a host feel native: the theme is already
  // neutral for everyone. This only hides chrome that cannot work in a pane.
  const isPane = typeof window !== 'undefined' && (
    !!window.openai ||
    window.self !== window.top ||
    new URLSearchParams(window.location.search).get('pane') === '1'
  )

  // Read the version off the backend rather than hardcoding it here, so the
  // footer can't drift from the installed package the way it did before.
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (data?.version && !cancelled) setAppVersion(data.version) })
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
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadingId, setDownloadingId] = useState(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(() => localStorage.getItem('previewUrl') || '')
  const [deletedFileToast, setDeletedFileToast] = useState(null)
  // Starts CLOSED and is opened only if the backend turns out to have no folder
  // (see the /api/folder/info effect). Starting it open flashed the picker over
  // the IDE for the moment it took to ask.
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [projectPath, setProjectPath] = useState(null)
  const [showLogs, setShowLogs] = useState(false)
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
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
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

  const ideContent = (
    <div className={`app ${isResizing ? 'resizing' : ''}`}>
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
          </div>
          <div className="top-bar-section top-bar-center">
            <div className="view-tabs">
              <button
                className={`view-tab ${!showPreview ? 'active' : ''}`}
                onClick={() => setShowPreview(false)}
              >
                Files
              </button>
              <button
                className={`view-tab ${showPreview ? 'active' : ''}`}
                onClick={() => setShowPreview(true)}
              >
                Preview
              </button>
            </div>
          </div>
          <div className="top-bar-section top-bar-right">
            {/* These shell out to a NATIVE terminal window on the user's desktop.
                Inside a host pane that window would open behind the app with no
                way back to it, so hide them there rather than ship a dead button. */}
            {!isPane && (<>
            <button
              className="btn-flat"
              onClick={async () => {
                try {
                  await fetch('/api/terminal/launch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: projectPath })
                  })
                } catch (err) {
                  console.error('Failed to launch terminal:', err)
                }
              }}
            >
              Terminal
            </button>
            <button
              className="btn-flat btn-claude"
              onClick={async () => {
                try {
                  await fetch('/api/terminal/launch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: projectPath, command: 'claude' })
                  })
                } catch (err) {
                  console.error('Failed to launch Claude:', err)
                }
              }}
            >
              Claude
            </button>
            <button
              className="btn-flat btn-codex"
              onClick={async () => {
                try {
                  await fetch('/api/terminal/launch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: projectPath, command: 'codex' })
                  })
                } catch (err) {
                  console.error('Failed to launch Codex:', err)
                }
              }}
            >
              Codex
            </button>
            <button
              className="btn-flat btn-gemini"
              onClick={async () => {
                try {
                  await fetch('/api/terminal/launch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: projectPath, command: 'gemini' })
                  })
                } catch (err) {
                  console.error('Failed to launch Gemini:', err)
                }
              }}
            >
              Gemini
            </button>
            </>)}
            {/* Deliberately OUTSIDE the !isPane block: a pane has no console,
                no devtools and no visible server log, so this is the only way
                to see what went wrong there — which is exactly where things go
                wrong. */}
            <button className="btn-flat" onClick={() => setShowLogs(true)}>
              Logs
            </button>
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

          {showPreview ? (
            <div className="preview-pane">
              <div className="preview-url-bar">
                <input
                  type="text"
                  className="preview-url-input"
                  placeholder="Enter URL (e.g., http://localhost:3000)"
                  value={previewUrl}
                  onChange={(e) => {
                    setPreviewUrl(e.target.value)
                    localStorage.setItem('previewUrl', e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      // Force iframe refresh by toggling key
                      const iframe = document.querySelector('.preview-iframe')
                      if (iframe) iframe.src = previewUrl
                    }
                  }}
                />
                <button
                  className="btn-flat"
                  onClick={() => {
                    const iframe = document.querySelector('.preview-iframe')
                    if (iframe) iframe.src = previewUrl
                  }}
                >
                  Go
                </button>
              </div>
              {previewUrl ? (
                <iframe
                  className="preview-iframe"
                  src={previewUrl}
                  title="App Preview"
                  style={{ pointerEvents: isResizing ? 'none' : 'auto' }}
                />
              ) : (
                <div className="preview-placeholder">
                  Enter a URL above to preview your app
                </div>
              )}
            </div>
          ) : loading ? (
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
  if (authStatus.loading) return null
  if (authStatus.signedIn) return ideContent
  return renderSignInGate()
}

export default App

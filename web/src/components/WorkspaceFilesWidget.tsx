import type { WorkspaceEntry } from '../lib/workspaceFiles'

type WorkspaceFilesWidgetProps = {
  busy: boolean
  error: string | null
  truncated: boolean
  entries: WorkspaceEntry[]
  search: string
  pendingWorkspacePaths: string[]
  workspaceDragType: string
  onRefresh: () => void
  onSearchChange: (value: string) => void
  onLinkPath: (path: string) => void
  formatSize: (n: number) => string
}

export function WorkspaceFilesWidget({
  busy,
  error,
  truncated,
  entries,
  search,
  pendingWorkspacePaths,
  workspaceDragType,
  onRefresh,
  onSearchChange,
  onLinkPath,
  formatSize,
}: WorkspaceFilesWidgetProps) {
  const filteredWorkspaceEntries = entries.filter((entry) => {
    if (!search.trim()) return true
    return entry.path.toLowerCase().includes(search.trim().toLowerCase())
  })

  return (
    <div className="sidebar-section">
      <div className="workspace-files-head">
        <h2>Workspace files</h2>
        <div className="workspace-files-actions">
          <button
            type="button"
            className="workspace-refresh-btn"
            onClick={onRefresh}
            disabled={busy}
            aria-label="Refresh workspace files"
            title="Refresh file list"
          >
            Refresh
          </button>
        </div>
      </div>
      <input
        className="workspace-search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search files..."
        aria-label="Search workspace files"
      />
      {error && <p className="warn">Could not list files ({error}).</p>}
      {!error && filteredWorkspaceEntries.length === 0 && !busy && (
        <p className="muted workspace-empty">No files yet in this workspace.</p>
      )}
      {busy && <p className="muted workspace-empty">Loading files…</p>}
      {filteredWorkspaceEntries.length > 0 && (
        <ul className="workspace-files-list" aria-label="Workspace files">
          {filteredWorkspaceEntries.map((entry) => (
            <li
              key={`${entry.type}-${entry.path}`}
              draggable={entry.type === 'file'}
              onDragStart={(e) => {
                if (entry.type !== 'file') return
                e.dataTransfer.setData(workspaceDragType, entry.path)
                e.dataTransfer.setData('text/plain', entry.path)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title={entry.type === 'file' ? 'Drag to composer to link this file' : undefined}
            >
              <span className="workspace-file-kind" aria-hidden>
                {entry.type === 'dir' ? 'D' : 'F'}
              </span>
              <span className="workspace-file-path" title={entry.path}>
                {entry.path}
              </span>
              {entry.type === 'file' && typeof entry.size === 'number' && (
                <span className="workspace-file-size">{formatSize(entry.size)}</span>
              )}
              {entry.type === 'file' && (
                <button
                  type="button"
                  className="workspace-link-btn"
                  onClick={() => onLinkPath(entry.path)}
                  disabled={pendingWorkspacePaths.includes(entry.path)}
                >
                  {pendingWorkspacePaths.includes(entry.path) ? 'Linked' : 'Link'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="muted workspace-empty">List truncated. Narrow files or cleanup to see all entries.</p>}
    </div>
  )
}

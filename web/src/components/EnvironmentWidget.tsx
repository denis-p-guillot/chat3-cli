type Meta = {
  model: string
  workspace: string
  base_dir: string
  user_workspace?: string
  user_workspace_abs?: string
}

type EnvironmentWidgetProps = {
  meta: Meta | null
  metaErr: string | null
  shortPath: (p: string) => string
}

export function EnvironmentWidget({ meta, metaErr, shortPath }: EnvironmentWidgetProps) {
  return (
    <div className="sidebar-section sidebar-widget">
      <h2>Environment</h2>
      {metaErr && <p className="warn">Could not load /api/meta ({metaErr}). Is the API running?</p>}
      {meta && (
        <dl className="meta-list">
          <div>
            <dt>Model</dt>
            <dd>{meta.model}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd title={meta.workspace}>{shortPath(meta.workspace)}</dd>
          </div>
          <div>
            <dt>Base dir</dt>
            <dd title={meta.base_dir}>{shortPath(meta.base_dir)}</dd>
          </div>
          {meta.user_workspace && (
            <div>
              <dt>Your workspace</dt>
              <dd title={meta.user_workspace}>{shortPath(meta.user_workspace)}</dd>
            </div>
          )}
          {meta.user_workspace_abs && (
            <div>
              <dt>Your folder (disk)</dt>
              <dd title={meta.user_workspace_abs}>{shortPath(meta.user_workspace_abs)}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}

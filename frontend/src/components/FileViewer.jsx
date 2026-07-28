import DataFrameViewer from './DataFrameViewer'
import LargeFilePreviewModal from './LargeFilePreviewModal'
import JsonViewer from './JsonViewer'
import CodeViewer from './CodeViewer'
import MarkdownViewer from './MarkdownViewer'

const PdfViewer = ({ content }) => (
  <div className="pdf-viewer">
    <iframe
      src={`/api/pdf?path=${encodeURIComponent(content.path)}`}
      title={content.filename}
    />
  </div>
)

const DocxViewer = ({ content }) => {
  return (
    <div className="docx-viewer">
      <div className="docx-content">
        {content.paragraphs.map((para, i) => {
          const style = para.style || ''
          if (style.startsWith('Heading 1')) return <h1 key={i}>{para.text}</h1>
          if (style.startsWith('Heading 2')) return <h2 key={i}>{para.text}</h2>
          if (style.startsWith('Heading 3')) return <h3 key={i}>{para.text}</h3>
          if (style.startsWith('Heading')) return <h4 key={i}>{para.text}</h4>
          if (style === 'Title') return <h1 key={i} className="docx-title">{para.text}</h1>
          if (style === 'Subtitle') return <h2 key={i} className="docx-subtitle">{para.text}</h2>
          if (style.includes('List')) return <li key={i}>{para.text}</li>
          return <p key={i}>{para.text}</p>
        })}
        {content.tables.map((table, ti) => (
          <table key={`table-${ti}`} className="docx-table">
            <tbody>
              {table.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    ri === 0 ? <th key={ci}>{cell}</th> : <td key={ci}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  )
}

const FileViewer = ({ content, canWrite, onSave, onSheetChange, saveStatus, onLargeFilePreviewReady, onLargeFileCancel }) => {
  if (!content) return null

  const renderViewer = () => {
    switch (content.type) {
      case 'massive_file':
        return (
          <LargeFilePreviewModal
            content={content}
            onPreviewReady={onLargeFilePreviewReady}
            onCancel={onLargeFileCancel}
          />
        )
      case 'dataframe':
        return <DataFrameViewer content={content} onSheetChange={onSheetChange} />
      case 'docx':
        return <DocxViewer content={content} />
      case 'image':
        return (
          <div className="image-viewer">
            <img
              src={`/api/image?path=${encodeURIComponent(content.path)}`}
              alt={content.filename}
            />
          </div>
        )
      case 'pdf':
        return <PdfViewer content={content} />
      case 'json':
        return <JsonViewer content={content} />
      case 'code':
        return (
          <CodeViewer
            content={content}
            canWrite={canWrite}
            onSave={onSave}
            saveStatus={saveStatus}
          />
        )
      case 'markdown':
        return (
          <CodeViewer
            content={content}
            canWrite={canWrite}
            onSave={onSave}
            saveStatus={saveStatus}
          />
        )
      case 'text':
        return (
          <CodeViewer
            content={content}
            canWrite={canWrite}
            onSave={onSave}
            saveStatus={saveStatus}
          />
        )
      case 'error':
        return (
          <div className="unknown-viewer">
            <p>Error: {content.message}</p>
          </div>
        )
      case 'unknown':
        return (
          <div className="unknown-viewer">
            <p>{content.message}</p>
          </div>
        )
      default:
        return (
          <div className="unknown-viewer">
            <p>Cannot preview this file type</p>
          </div>
        )
    }
  }

  return (
    <div className="file-viewer-container">
      {renderViewer()}
    </div>
  )
}

export default FileViewer

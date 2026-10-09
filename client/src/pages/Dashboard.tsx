import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, isDemo, type BillSummary } from '../api';
import { useSession } from '../App';
import { billTitle, money, usePolling } from '../lib';

const STATUS_TEXT: Record<BillSummary['status'], string> = {
  pending: 'Uploading',
  extracting: 'Reading your bill',
  awaiting_review: 'Ready for your review',
  analyzing: 'Checking charges',
  complete: 'Audit complete',
  failed: 'Couldn’t be read',
};

const disputed = (b: BillSummary) =>
  (b.totals?.billingErrors ?? 0) + (b.totals?.pricingConcerns ?? 0) + (b.totals?.insuranceIssues ?? 0);

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useSession();
  const firstName = user?.name.trim().split(/\s+/)[0];
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const inProgress = (bills?: BillSummary[]) => !!bills?.some((b) => ['pending', 'extracting', 'analyzing'].includes(b.status));
  const { data: bills, error } = usePolling(() => api.listBills(), 4000, inProgress);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.type !== 'application/pdf') return setUploadError('Upload your bill as a PDF.');
    if (file.size > 15 * 1024 * 1024) return setUploadError('That file is over 15 MB. Upload a smaller PDF.');
    setUploading(true);
    setUploadError(undefined);
    try {
      navigate(`/bills/${await api.uploadBill(file)}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload failed. Try again.');
      setUploading(false);
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-head">
        <div>
          <h1>{firstName ? `Hi, ${firstName}!` : 'Welcome back!'}</h1>
          <p className="greeting-sub">{isDemo ? 'Audit a sample bill to see how ClaimCheck works.' : 'Upload an itemized bill, or pick up where you left off.'}</p>
        </div>
        {isDemo ? (
          <div className="upload">
            <button className="primary" onClick={() => upload(new File([], 'sample-itemized-bill.pdf', { type: 'application/pdf' }))} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Audit the sample bill'}
            </button>
            <p className="hint">
              This demo runs without a backend, so it uses a sample bill instead of uploads.{' '}
              <a href="/samples/sample-itemized-bill.pdf" target="_blank" rel="noreferrer">View the bill (PDF)</a>
            </p>
          </div>
        ) : (
        <div className="upload">
          <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <button className="primary" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload a bill'}
          </button>
          <p className="hint">An itemized bill as a PDF. Ask the billing office for one that lists every charge with its code.</p>
          {uploadError && <p className="form-error" role="alert">{uploadError}</p>}
        </div>
        )}
      </div>

      <h2 className="list-heading">Your bills</h2>
      {error && <p className="form-error">Your bills couldn't be loaded: {error}</p>}
      {bills && bills.length === 0 && (
        <div className="empty">
          <p>No bills yet. Upload your first itemized bill to see which charges look wrong.</p>
        </div>
      )}
      {bills && bills.length > 0 && (
        <ul className="bill-list">
          {bills.map((b) => (
            <li key={b._id}>
              <Link to={`/bills/${b._id}`} className="bill-row">
                <span className="bill-name">{billTitle(b)}</span>
                <span className={`status status-${b.status}`}>{isDemo && b.status === 'pending' ? 'Uploaded' : STATUS_TEXT[b.status]}</span>
                <span className="bill-meta">
                  Uploaded {new Date(b.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
                <span className="bill-amount">
                  {b.status === 'complete' && b.totals ? (
                    disputed(b) > 0 ? <><strong>{money(disputed(b))}</strong> to dispute</> : 'No issues found'
                  ) : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, isDemo, type Bill } from '../api';
import { SAMPLE_BILL_URL } from '../api/demo';
import { billTitle, usePolling } from '../lib';
import ResultsView from '../components/ResultsView';
import ReviewView from '../components/ReviewView';

const STEPS = ['Upload', 'Read line items', 'Your review', 'Audit', 'Results'];
const stepIndex = (s: Bill['status']) =>
  ({ pending: 0, extracting: 1, awaiting_review: 2, analyzing: 3, complete: 4, failed: 1 })[s];

// In the demo, a pending bill is waiting for the visitor to click Next, not for the server.
const isWorking = (b?: Bill) =>
  !b ||
  (b.status === 'pending' && !isDemo) ||
  ['extracting', 'analyzing'].includes(b.status) ||
  b.letter?.status === 'drafting' ||
  !!b.eobs?.some((e) => e.status === 'pending' || e.status === 'extracting');

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: bill, error, refresh } = usePolling(() => api.getBill(id!), 2000, isWorking);

  if (error && !bill) return <p className="form-error">This bill couldn't be loaded: {error}. <Link to="/">Back to your bills</Link></p>;
  if (!bill) return null;

  async function remove() {
    if (!confirm('Delete this bill, its results, and its letter? This can’t be undone.')) return;
    await api.deleteBill(bill!._id);
    navigate('/');
  }

  return (
    <div className="bill-page">
      <nav className="crumbs">
        <Link to="/">Your bills</Link>
      </nav>
      <BillTitle bill={bill} onRenamed={refresh} />

      <ol className="progress" aria-label="Progress">
        {STEPS.map((s, i) => {
          const current = stepIndex(bill.status);
          const state = i < current || bill.status === 'complete' ? 'done' : i === current ? 'current' : 'todo';
          return (
            <li key={s} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              {s}
            </li>
          );
        })}
      </ol>

      {isDemo && bill.status === 'pending' ? (
        <UploadedPreview bill={bill} onStarted={refresh} />
      ) : bill.status === 'pending' || bill.status === 'extracting' ? (
        <Working title="Reading your bill" body="Pulling out each charge and checking it against the bill itself and Medicare's code list. This usually takes under a minute." />
      ) : bill.status === 'analyzing' ? (
        <Working title="Checking your charges" body="Running every audit check that applies to this kind of bill." />
      ) : bill.status === 'failed' ? (
        <div className="notice notice-error" role="alert">
          <h2>This bill couldn't be read</h2>
          <p>{bill.error ?? 'Something went wrong while reading the file.'}</p>
          <p>Make sure the PDF is an itemized bill with codes for each charge, not a summary statement.</p>
          <RetryButton billId={bill._id} onRetried={refresh} />
        </div>
      ) : bill.status === 'awaiting_review' ? (
        <ReviewView bill={bill} onSubmitted={refresh} />
      ) : (
        <ResultsView bill={bill} onChange={refresh} />
      )}

      <footer className="bill-footer">
        {bill.fileDeleted && <p className="hint">The original PDF was deleted after 30 days to protect your privacy. Your results are still here.</p>}
        <button className="link-button danger" onClick={remove}>Delete this bill</button>
      </footer>
    </div>
  );
}

/** The bill's name, with an inline editor so the patient can call it something they'll recognize. */
function BillTitle({ bill, onRenamed }: { bill: Bill; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fallback = bill.providerName || bill.originalFilename || 'Medical bill';

  function start() {
    setName(bill.displayName ?? '');
    setError(undefined);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.renameBill(bill._id, name);
      setEditing(false);
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The name couldn\u2019t be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form className="rename" onSubmit={save}>
        <label>
          Bill name <span className="hint">leave blank to use "{fallback}"</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            placeholder={fallback}
            maxLength={100}
            autoFocus
          />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    );
  }

  return (
    <div className="bill-title">
      <h1>{billTitle(bill)}</h1>
      <button className="link-button small" onClick={start}>Rename</button>
      {bill.displayName && (bill.providerName || bill.accountNumber) && (
        <span className="bill-meta">{[bill.providerName, bill.accountNumber && `Account ${bill.accountNumber}`].filter(Boolean).join(', ')}</span>
      )}
      {!bill.displayName && bill.accountNumber && <span className="bill-meta">Account {bill.accountNumber}</span>}
    </div>
  );
}

function RetryButton({ billId, onRetried }: { billId: string; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function retry() {
    setBusy(true);
    setError(undefined);
    try {
      await api.retryBill(billId);
      onRetried();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The bill couldn\u2019t be restarted.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="primary" onClick={retry} disabled={busy}>{busy ? 'Restarting…' : 'Try again'}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}

/** Demo only: shows the uploaded sample bill and waits for the visitor to continue. */
function UploadedPreview({ bill, onStarted }: { bill: Bill; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  async function next() {
    setBusy(true);
    await api.startExtraction(bill._id);
    onStarted();
  }
  return (
    <section className="uploaded">
      <div className="uploaded-head">
        <div>
          <h2>Bill uploaded</h2>
          <p className="hint">
            {bill.originalFilename} &middot; <a href={SAMPLE_BILL_URL} target="_blank" rel="noreferrer">Open in a new tab</a>
          </p>
        </div>
        <button className="primary" onClick={next} disabled={busy}>{busy ? 'Starting…' : 'Next: read line items'}</button>
      </div>
      <a href={SAMPLE_BILL_URL} target="_blank" rel="noreferrer" className="bill-preview">
        <img src={SAMPLE_BILL_URL.replace(/\.pdf$/, '.png')} alt="The uploaded itemized bill from Lakeshore Family Medicine, listing eight charges" />
      </a>
      <p className="hint">Next, ClaimCheck reads every charge on the bill, then checks each one against the bill's own text and Medicare's code list.</p>
    </section>
  );
}

function Working({ title, body }: { title: string; body: string }) {
  return (
    <div className="working" role="status">
      <span className="pulse" aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </div>
  );
}

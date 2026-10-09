import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Bill } from '../api';
import { usePolling } from '../lib';
import ResultsView from '../components/ResultsView';
import ReviewView from '../components/ReviewView';

const STEPS = ['Upload', 'Read line items', 'Your review', 'Audit', 'Results'];
const stepIndex = (s: Bill['status']) =>
  ({ pending: 0, extracting: 1, awaiting_review: 2, analyzing: 3, complete: 4, failed: 1 })[s];

const isWorking = (b?: Bill) =>
  !b || ['pending', 'extracting', 'analyzing'].includes(b.status) || b.letter?.status === 'drafting';

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
      <div className="bill-title">
        <h1>{bill.providerName ?? bill.originalFilename ?? 'Medical bill'}</h1>
        {bill.accountNumber && <span className="bill-meta">Account {bill.accountNumber}</span>}
      </div>

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

      {bill.status === 'pending' || bill.status === 'extracting' ? (
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

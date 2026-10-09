import { useRef, useState } from 'react';
import { api, isDemo, type Bill, type Eob } from '../api';
import { money, shortDate } from '../lib';

const STATUS_TEXT: Record<Eob['status'], string> = {
  pending: 'Uploading',
  extracting: 'Reading your statement',
  ready: 'Read',
  failed: 'Couldn’t be read',
};

export default function InsurancePanel({ bill, onChange }: { bill: Bill; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const eobs = bill.eobs ?? [];
  const recon = bill.reconciliation;

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.type !== 'application/pdf') return setError('Upload your statement as a PDF.');
    setBusy(true);
    setError(undefined);
    try {
      await api.uploadEob(bill._id, file);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed. Try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function act(action: () => Promise<void>) {
    setError(undefined);
    try {
      await action();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    }
  }

  const uncovered = recon ? Math.round((recon.maxExpectedDue - recon.patientResponsibility) * 100) / 100 : 0;
  const billLines = bill.lineItems.length;
  const matchedLines = recon ? billLines - recon.unmatchedBillLineIds.length : 0;

  return (
    <section className="insurance">
      <h2>Compare with your insurance statement</h2>
      {eobs.length === 0 && (
        <p>
          After your insurer processes a claim, it sends an Explanation of Benefits (EOB) showing what you owe for each
          service. Add it here to check whether this bill asks for more, or includes charges your insurer never saw.
        </p>
      )}

      {recon && (
        <dl className="insurance-summary">
          <dt>You owe, per your insurer</dt><dd>{money(recon.patientResponsibility)}</dd>
          {uncovered > 0 && (<><dt>Charges not on your statement</dt><dd>{money(uncovered)}</dd></>)}
          <dt>Most you should owe</dt><dd>{money(recon.maxExpectedDue)}</dd>
          {bill.amountDue !== undefined && (
            <><dt>This bill asks for</dt><dd className={bill.amountDue > recon.maxExpectedDue + 0.005 ? 'amt-error' : ''}>{money(bill.amountDue)}</dd></>
          )}
          <dt>Charges matched</dt><dd>{matchedLines} of {billLines}</dd>
        </dl>
      )}

      {eobs.map((eob) => (
        <div key={eob.id} className="eob">
          <div className="eob-head">
            <span className="eob-name">{eob.payer ?? eob.originalFilename ?? 'Insurance statement'}{eob.claimNumber && <span className="hint">, claim {eob.claimNumber}</span>}</span>
            <span className={`status status-${eob.status === 'ready' ? 'complete' : eob.status === 'failed' ? 'failed' : 'pending'}`}>{STATUS_TEXT[eob.status]}</span>
          </div>
          {eob.status === 'failed' && (
            <p className="form-error">
              {eob.error ?? 'This statement couldn’t be read.'}{' '}
              <button className="link-button small" onClick={() => act(() => api.retryEob(bill._id, eob.id))}>Try again</button>
            </p>
          )}
          {eob.status === 'ready' && eob.lines.length > 0 && (
            <table className="eob-lines">
              <thead>
                <tr><th>Date</th><th>Service</th><th className="num">Billed to insurer</th><th className="num">Plan paid</th><th className="num">You owe</th></tr>
              </thead>
              <tbody>
                {eob.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="date">{shortDate(l.dateOfService)}</td>
                    <td>
                      {l.code && <strong>{l.code} </strong>}{l.description}
                      {l.foundInDocument === false && <span className="row-note">We couldn't find this line on the statement. Check it against your copy.</span>}
                    </td>
                    <td className="num">{money(l.billed)}</td>
                    <td className="num">{l.planPaid !== undefined ? money(l.planPaid) : '—'}</td>
                    <td className="num"><strong>{money(l.patientResponsibility)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="link-button small danger" onClick={() => act(() => api.deleteEob(bill._id, eob.id))}>Remove this statement</button>
        </div>
      ))}

      {isDemo && eobs.length === 0 && (
        // The demo has no backend, so it runs on a sample statement instead of an upload.
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => upload(new File([], 'sample-insurance-eob.pdf', { type: 'application/pdf' }))}>
            {busy ? 'Adding…' : 'Add the sample insurance statement'}
          </button>
          <a href="/samples/sample-insurance-eob.pdf" target="_blank" rel="noreferrer">View the statement (PDF)</a>
        </div>
      )}
      {!isDemo && eobs.length < 5 && (
        <div className="actions">
          <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <button className={eobs.length ? '' : 'primary'} onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : eobs.length ? 'Add another statement' : 'Add insurance statement'}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

import { useState } from 'react';
import { api, type AdmissionAnswer, type Bill, type LineItem } from '../api';
import { money, shortDate } from '../lib';

const ANSWERS: { value: AdmissionAnswer; label: string }[] = [
  { value: 'admitted', label: 'Yes, I was formally admitted' },
  { value: 'not_admitted', label: 'No, or I was kept under observation' },
  { value: 'unsure', label: 'I’m not sure' },
];

export default function ReviewView({ bill, onSubmitted }: { bill: Bill; onSubmitted: () => void }) {
  const [items, setItems] = useState<LineItem[]>(bill.lineItems);
  const [answer, setAnswer] = useState<AdmissionAnswer>(bill.suggestedBillType === 'physician' ? 'not_admitted' : 'unsure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isHospital = bill.suggestedBillType !== 'physician';
  const flagged = items.filter((i) => i.extractionStatus === 'needs_review').length;

  const update = (id: string, patch: Partial<LineItem>) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await api.submitReview(bill._id, {
        admissionAnswer: answer,
        lineItems: items.map(({ id, code, description, modifiers, units, charge, dateOfService, notReceived }) => ({
          id, code: code.trim().toUpperCase(), description, modifiers, units, charge, dateOfService, notReceived,
        })),
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your review couldn’t be saved.');
      setBusy(false);
    }
  }

  return (
    <section className="review">
      <div className="review-intro">
        <h2>Check what we read from your bill</h2>
        <p>
          {flagged > 0
            ? `${flagged} ${flagged === 1 ? 'line needs' : 'lines need'} a look: we couldn't confirm ${flagged === 1 ? 'it' : 'them'} against your bill. Compare with your paper copy and fix anything that's wrong.`
            : 'Every line matched your bill. Compare with your copy anyway, and mark anything you didn’t receive.'}
        </p>
        {bill.totalsReconcile === false && (
          <p className="notice notice-concern">The lines we read don't add up to the bill's total of {money(bill.statedTotal)}. A line may be missing or misread.</p>
        )}
      </div>

      <div className="ledger review-ledger" role="table" aria-label="Line items">
        <div className="ledger-head" role="row">
          <span role="columnheader">Date</span>
          <span role="columnheader">Code</span>
          <span role="columnheader">Service</span>
          <span role="columnheader" className="num">Units</span>
          <span role="columnheader" className="num">Charge</span>
          <span role="columnheader">Received?</span>
        </div>
        {items.map((item) => (
          <div key={item.id} className={`ledger-row ${item.extractionStatus === 'needs_review' ? 'row-review' : ''} ${item.notReceived ? 'row-struck' : ''}`} role="row">
            <span role="cell" className="date">{shortDate(item.dateOfService)}</span>
            <span role="cell">
              <input
                className="code-input"
                value={item.code}
                aria-label={`Code for ${item.description}`}
                onChange={(e) => update(item.id, { code: e.target.value })}
                maxLength={7}
              />
            </span>
            <span role="cell" className="desc">
              {item.description}
              {item.extractionStatus === 'needs_review' && item.reviewReasons.map((r) => <span key={r} className="row-note">{r}</span>)}
              {item.extractionStatus === 'unverified' && <span className="row-note quiet">Not in Medicare's code list, so prices and coding rules can't be checked for this line.</span>}
            </span>
            <span role="cell" className="num">
              <input
                className="units-input"
                type="number"
                min={1}
                value={item.units}
                aria-label={`Units for ${item.description}`}
                onChange={(e) => update(item.id, { units: Number(e.target.value) || 1 })}
              />
            </span>
            <span role="cell" className="num">{money(item.charge)}</span>
            <span role="cell">
              <label className="check">
                <input type="checkbox" checked={item.notReceived} onChange={(e) => update(item.id, { notReceived: e.target.checked })} />
                I didn't get this
              </label>
            </span>
          </div>
        ))}
      </div>

      {isHospital && (
        <fieldset className="admission">
          <legend>Were you formally admitted to the hospital?</legend>
          <p className="hint">
            Staying overnight doesn't always mean you were admitted. If you got a notice saying you were under observation, you were an outpatient.
          </p>
          {ANSWERS.map((a) => (
            <label key={a.value} className="radio">
              <input type="radio" name="admission" value={a.value} checked={answer === a.value} onChange={() => setAnswer(a.value)} />
              {a.label}
            </label>
          ))}
        </fieldset>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? 'Starting audit…' : 'Run the audit'}</button>
      </div>
    </section>
  );
}

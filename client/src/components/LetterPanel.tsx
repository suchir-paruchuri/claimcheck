import { useEffect, useState } from 'react';
import { api, type Bill } from '../api';
import { busyRetryNote } from '../lib';

export default function LetterPanel({ bill, onChange }: { bill: Bill; onChange: () => void }) {
  const status = bill.letter?.status ?? 'none';
  const [text, setText] = useState(bill.letter?.text ?? '');
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'ready' && saved) setText(bill.letter?.text ?? '');
  }, [status, bill.letter?.text, saved]);

  async function draft() {
    setBusy(true);
    await api.requestLetter(bill._id);
    setBusy(false);
    onChange();
  }

  async function save() {
    await api.saveLetter(bill._id, text);
    setSaved(true);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'dispute-letter.txt' });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="letter">
      <h2>Your dispute letter</h2>
      {status === 'none' && (
        <>
          <p>We'll write a letter to the billing office covering each finding above, using only what the audit found.</p>
          <button className="primary" onClick={draft} disabled={busy}>Draft my letter</button>
        </>
      )}
      {status === 'drafting' && (
        <p role="status" className="drafting">{busyRetryNote(bill.retryAt?.letter) ?? 'Drafting your letter. This usually takes under a minute.'}</p>
      )}
      {status === 'failed' && (
        <>
          <p className="form-error">The letter couldn't be drafted. Try again in a minute.</p>
          <button className="primary" onClick={draft} disabled={busy}>Try again</button>
        </>
      )}
      {status === 'ready' && (
        <>
          {bill.letter?.stale && (
            <div className="notice notice-concern" role="status">
              <p>Your results changed after this letter was drafted, so it may be missing findings. Redrafting replaces any edits you made.</p>
              <button className="primary" onClick={draft} disabled={busy}>Redraft my letter</button>
            </div>
          )}
          <p className="hint">Edit anything you like before sending it. Keep a copy, and send it to the billing office in writing.</p>
          <textarea
            className="letter-text"
            value={text}
            onChange={(e) => { setText(e.target.value); setSaved(false); }}
            aria-label="Dispute letter"
            rows={22}
          />
          <div className="actions">
            <button className="primary" onClick={download}>Download letter</button>
            <button onClick={save} disabled={saved}>{saved ? 'Changes saved' : 'Save changes'}</button>
            <button onClick={() => navigator.clipboard.writeText(text)}>Copy text</button>
          </div>
          <p className="hint">This letter isn't legal advice.</p>
        </>
      )}
    </section>
  );
}

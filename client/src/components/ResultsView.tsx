import { useState } from 'react';
import type { Bill, Finding } from '../api';
import { BILL_TYPE_LABEL, CHECK_LABEL, money, shortDate } from '../lib';
import InsurancePanel from './InsurancePanel';
import LetterPanel from './LetterPanel';

export default function ResultsView({ bill, onChange }: { bill: Bill; onChange: () => void }) {
  const totals = bill.totals ?? { billed: 0, billingErrors: 0, pricingConcerns: 0 };
  const disputable = bill.findings.filter((f) => f.category !== 'info');
  const byLine = new Map<string, Finding[]>();
  const totalLevel: Finding[] = [];
  const dueLevel: Finding[] = [];
  for (const f of bill.findings) {
    // Attach each finding to its last line, so a duplicate or an unbundled pair is annotated where the extra charge is.
    const anchor = f.lineItemIds.at(-1);
    if (!anchor) (f.checkId === 'insurance_balance' ? dueLevel : totalLevel).push(f);
    else byLine.set(anchor, [...(byLine.get(anchor) ?? []), f]);
  }
  const hospitalStay = bill.billType === 'inpatient' || bill.billType === 'uncertain';
  const hasInsurance = bill.findings.some((f) => f.category === 'insurance_issue');
  const recon = bill.reconciliation;
  const overDue = recon && bill.amountDue !== undefined && bill.amountDue > recon.maxExpectedDue + 0.005;

  return (
    <section className="results">
      <p className="verdict">
        {disputable.length === 0 ? (
          <>No problems found on this bill. Every check that applies came back clean.</>
        ) : (
          <>
            {totals.billingErrors > 0 && <>We found <strong className="amt-error">{money(totals.billingErrors)}</strong> in likely billing errors</>}
            {totals.billingErrors > 0 && totals.pricingConcerns > 0 && ' and '}
            {totals.pricingConcerns > 0 && (
              <>{totals.billingErrors > 0 ? '' : 'We found '}<strong className="amt-concern">{money(totals.pricingConcerns)}</strong> charged above typical Medicare rates</>
            )}
            {' '}on a {money(totals.billed)} bill.
          </>
        )}
      </p>
      {overDue && (
        <p className="verdict-sub">
          Your insurance statement says you should owe at most <strong>{money(recon!.maxExpectedDue)}</strong>,
          but this bill asks for <strong className="amt-error">{money(bill.amountDue)}</strong>.
        </p>
      )}

      <p className="bill-type">
        {BILL_TYPE_LABEL[bill.billType ?? 'uncertain']}.{' '}
        {bill.classificationReasons?.[0] && <span className="hint">{bill.classificationReasons.at(-1)}</span>}
      </p>

      {hospitalStay && <HospitalStayNote bill={bill} />}

      <div className="key" aria-label="Key">
        <span><i className="swatch swatch-error" /> Billing error: should be corrected</span>
        <span><i className="swatch swatch-concern" /> Pricing concern: ask for a justification or reduction</span>
        {hasInsurance && <span><i className="swatch swatch-insurance" /> Insurance mismatch: check against your insurance statement</span>}
      </div>

      <div className="ledger annotated" role="table" aria-label="Your bill with findings">
        <div className="ledger-head" role="row">
          <span role="columnheader">Date</span>
          <span role="columnheader">Code</span>
          <span role="columnheader">Service</span>
          <span role="columnheader" className="num">Charge</span>
          <span role="columnheader" className="margin-head">What we found</span>
        </div>
        {bill.lineItems.map((item) => {
          const notes = byLine.get(item.id) ?? [];
          // Strike the charge only when an error disputes all of it; a partial error (extra units) is marked in red instead.
          const errors = notes.filter((n) => n.category === 'billing_error');
          const worst = errors.some((n) => n.amount >= item.charge) ? 'error'
            : errors.length ? 'error-partial'
            : notes.some((n) => n.category === 'pricing_concern') ? 'concern'
            : notes.some((n) => n.category === 'insurance_issue') ? 'insurance' : '';
          return (
            <div key={item.id} className={`ledger-row ${worst ? `row-${worst}` : ''}`} role="row">
              <span role="cell" className="date">{shortDate(item.dateOfService)}</span>
              <span role="cell" className="code">{item.code}{item.units > 1 && <span className="units"> ×{item.units}</span>}</span>
              <span role="cell" className="desc">{item.description}</span>
              <span role="cell" className="num charge">{money(item.charge)}</span>
              <span role="cell" className="margin">
                {notes.map((n) => <Annotation key={n.id} finding={n} />)}
              </span>
            </div>
          );
        })}
        {totalLevel.length > 0 && (
          <div className="ledger-row row-error bill-level" role="row">
            <span role="cell" className="desc">Bill total</span>
            <span role="cell" className="num charge">{money(bill.statedTotal)}</span>
            <span role="cell" className="margin">{totalLevel.map((n) => <Annotation key={n.id} finding={n} />)}</span>
          </div>
        )}
        {dueLevel.length > 0 && (
          <div className="ledger-row row-error-partial bill-level" role="row">
            <span role="cell" className="desc">Amount you're asked to pay</span>
            <span role="cell" className="num charge">{money(bill.amountDue)}</span>
            <span role="cell" className="margin">{dueLevel.map((n) => <Annotation key={n.id} finding={n} />)}</span>
          </div>
        )}
      </div>

      <InsurancePanel bill={bill} onChange={onChange} />
      <ChecksSummary bill={bill} />
      {disputable.length > 0 && <LetterPanel bill={bill} onChange={onChange} />}
    </section>
  );
}

function Annotation({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const e = finding.evidence;
  return (
    <div className={`note note-${finding.category}`}>
      <p>{finding.message}</p>
      {finding.checkId === 'pricing' && (
        <>
          <button className="link-button small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide the math' : 'Show the math'}
          </button>
          {open && (
            <dl className="math">
              <dt>Medicare benchmark</dt><dd>{money(Number(e.medicareBenchmark))}</dd>
              <dt>Billed charge</dt><dd>{money(Number(e.billedCharge))}</dd>
              <dt>Ratio</dt><dd>{Number(e.ratio).toFixed(2)}×</dd>
              <dt>Flagged above</dt><dd>{Number(e.threshold).toFixed(2)}×</dd>
              <dt>Source</dt><dd>{String(e.source)}, {String(e.dataVersion)}</dd>
            </dl>
          )}
        </>
      )}
      {finding.category === 'insurance_issue' && <p className="source">Compared with your insurance statement</p>}
      {(finding.checkId === 'unbundling' || finding.checkId === 'unit_limits') && (
        <p className="source">Source: {String(e.rule)}, {String(e.dataVersion)}</p>
      )}
    </div>
  );
}

function HospitalStayNote({ bill }: { bill: Bill }) {
  const [why, setWhy] = useState(false);
  return (
    <div className="notice notice-info">
      <h2>We didn't compare individual prices on this bill</h2>
      <p>
        Hospital stays are usually paid as one bundled amount for the whole stay, not item by item, so comparing each line to a
        standard price would be misleading. We still checked for duplicate charges, math errors, charges outside your stay dates,
        and services you didn't receive.
      </p>
      {bill.billType === 'uncertain' && (
        <p>We couldn't tell for sure whether this was an inpatient stay, so we ran only the checks that are safe either way.</p>
      )}
      <p>Your doctors usually bill separately from the hospital. Upload those bills too: they get every check.</p>
      <button className="link-button small" aria-expanded={why} onClick={() => setWhy(!why)}>{why ? 'Hide details' : 'Why?'}</button>
      {why && (
        <p className="hint">
          Medicare pays inpatient stays with a single payment based on the diagnosis (a DRG), and its coding-rule tables (NCCI and MUE)
          are published for doctors' and outpatient hospital claims, not inpatient hospital charges.
        </p>
      )}
    </div>
  );
}

function ChecksSummary({ bill }: { bill: Bill }) {
  return (
    <details className="checks">
      <summary>What we checked</summary>
      <ul>
        {bill.checksRun?.map((c) => <li key={c} className="ran">{CHECK_LABEL[c] ?? c}</li>)}
        {bill.checksSkipped?.map((s) => (
          <li key={s.checkId} className="skipped">{CHECK_LABEL[s.checkId] ?? s.checkId}: skipped. {s.reason}</li>
        ))}
      </ul>
      <p className="hint">
        Prices are compared with Medicare's 2026 rates, not what your insurer agreed to pay, so a flagged price means
        "well above typical," not proof of overcharging. This isn't legal advice.
      </p>
    </details>
  );
}

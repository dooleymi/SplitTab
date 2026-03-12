// ── Set default settlement date to today ─────────────────────────────────
(function () {
  const today = new Date();
  const iso = today.toISOString().split('T')[0];
  document.getElementById('settlementDate').value = iso;
})();

// ── Tax rate radio — visual state ────────────────────────────────────────
function refreshTaxBtns() {
  document.querySelectorAll('#taxGroup label').forEach(label => {
    const input = label.querySelector('input');
    const btn   = label.querySelector('.tax-btn');
    if (input.checked) {
      btn.className = 'tax-btn block text-center border rounded-lg py-2 text-sm select-none transition-colors bg-blue-600 text-white border-blue-600';
    } else {
      btn.className = 'tax-btn block text-center border border-slate-300 rounded-lg py-2 text-sm select-none transition-colors text-slate-700 hover:border-blue-400 hover:bg-blue-50';
    }
  });
}
document.querySelectorAll('#taxGroup input').forEach(r => r.addEventListener('change', refreshTaxBtns));
refreshTaxBtns();

// ── Date helpers ─────────────────────────────────────────────────────────
function parseLocalDate(str) {
  // Parse YYYY-MM-DD as local noon (avoids UTC timezone drift)
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

// Add N months, clamping to end-of-month (handles Jan 31 + 6m → Jul 31, Oct 31 + 6m → Apr 30, etc.)
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / 86400000;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Build coupon schedule ────────────────────────────────────────────────
// Coupon dates are derived from the maturity date (same day/month, 6-monthly).
// Returns all coupon dates strictly after settlementDate, and the last one on/before it.
function getCouponSchedule(maturityDate, settlementDate) {
  const future = [];
  let d = new Date(maturityDate);
  while (d.getTime() > settlementDate.getTime()) {
    future.unshift(new Date(d));
    d = addMonths(d, -6);
  }
  return { futureDates: future, lastCouponDate: new Date(d) };
}

// ── Newton-Raphson IRR solver ─────────────────────────────────────────────
// Finds r such that Σ cashFlows[i] / (1+r)^timesYears[i] = 0
function solveIRR(cashFlows, timesYears) {
  let r = 0.04;
  for (let iter = 0; iter < 500; iter++) {
    let npv = 0, dnpv = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      const t  = timesYears[i];
      const df = Math.pow(1 + r, -t);
      npv  += cashFlows[i] * df;
      dnpv -= t * cashFlows[i] * df / (1 + r);
    }
    if (Math.abs(dnpv) < 1e-15) break;
    const dr = -npv / dnpv;
    r += dr;
    if (Math.abs(dr) < 1e-12) break;
  }
  return r;
}

// ── Format helpers ───────────────────────────────────────────────────────
function pct(v, dp = 2) { return (v * 100).toFixed(dp) + '%'; }
function gbp(v, dp = 4) { return '£' + v.toFixed(dp); }

// ── Main calculation ─────────────────────────────────────────────────────
document.getElementById('calcBtn').addEventListener('click', () => {
  const matStr = document.getElementById('maturityDate').value;
  const setStr = document.getElementById('settlementDate').value;
  const cpnStr = document.getElementById('couponRate').value;
  const prcStr = document.getElementById('cleanPrice').value;
  const taxEl  = document.querySelector('input[name="taxRate"]:checked');

  if (!matStr || !cpnStr || !prcStr || !taxEl) {
    alert('Please fill in all fields.');
    return;
  }

  const maturityDate   = parseLocalDate(matStr);
  const settlementDate = setStr ? parseLocalDate(setStr) : new Date();
  const annualCoupon   = parseFloat(cpnStr) / 100;   // as decimal
  const cleanPrice     = parseFloat(prcStr);
  const taxRate        = parseFloat(taxEl.value) / 100;

  if (cleanPrice <= 0) { alert('Clean price must be positive.'); return; }
  if (maturityDate <= settlementDate) { alert('Maturity date must be after settlement date.'); return; }

  // Coupon schedule
  const { futureDates, lastCouponDate } = getCouponSchedule(maturityDate, settlementDate);
  if (futureDates.length === 0) { alert('No future coupon dates found. Check maturity date.'); return; }
  const nextCouponDate = futureDates[0];

  // Accrued interest — Actual/Actual (ICMA)
  const daysInPeriod  = daysBetween(lastCouponDate, nextCouponDate);
  const daysSinceLast = daysBetween(lastCouponDate, settlementDate);
  const semiCoupon    = (annualCoupon / 2) * 100;       // gross £ per £100 nominal
  const accrued       = semiCoupon * (daysSinceLast / daysInPeriod);
  const dirtyPrice    = cleanPrice + accrued;

  const capitalGain   = 100 - cleanPrice;               // positive = discount, tax-free
  const yearsToMat    = daysBetween(settlementDate, maturityDate) / 365.25;

  // After-tax semi-annual coupon
  const afterTaxSemi  = semiCoupon * (1 - taxRate);

  // Build cash flow vectors: t=0 pay dirty price, then receive coupons, then par at maturity
  function buildCFs(semi) {
    const cfs = [-dirtyPrice], ts = [0];
    futureDates.forEach((d, i) => {
      ts.push(daysBetween(settlementDate, d) / 365.25);
      // Final payment: coupon + par (£100); par is always tax-free
      cfs.push(i < futureDates.length - 1 ? semi : semi + 100);
    });
    return { cfs, ts };
  }

  const preTaxCFs  = buildCFs(semiCoupon);
  const postTaxCFs = buildCFs(afterTaxSemi);

  const yieldPre  = solveIRR(preTaxCFs.cfs,  preTaxCFs.ts);
  const yieldPost = solveIRR(postTaxCFs.cfs, postTaxCFs.ts);
  const dragBps   = (yieldPre - yieldPost) * 10000;

  // Tax-equivalent gross yield: the gross interest rate a fully-taxable
  // investment (savings account, corporate bond) would need to pay to
  // deliver the same after-tax return as this gilt.
  // = afterTaxYield / (1 − taxRate)
  // Because the capital gain is tax-free, this will exceed the pre-tax
  // YTM for discount gilts — that's the core advantage.
  const taxEquivYield = taxRate > 0 ? yieldPost / (1 - taxRate) : yieldPost;

  // ── Bond-basis (ICMA) convention ────────────────────────────────────────
  // t in semi-annual periods; first period is fractional
  function buildCFsPeriodic(semi) {
    const cfs = [-dirtyPrice], ts = [0];
    futureDates.forEach((d, i) => {
      ts.push(daysBetween(settlementDate, d) / daysInPeriod);
      cfs.push(i < futureDates.length - 1 ? semi : semi + 100);
    });
    return { cfs, ts };
  }

  const preTaxPeriodic  = buildCFsPeriodic(semiCoupon);
  const postTaxPeriodic = buildCFsPeriodic(afterTaxSemi);

  const semiRPre  = solveIRR(preTaxPeriodic.cfs,  preTaxPeriodic.ts);
  const semiRPost = solveIRR(postTaxPeriodic.cfs, postTaxPeriodic.ts);
  const ytmBondPre  = semiRPre  * 2;
  const ytmBondPost = semiRPost * 2;
  const ytmEffPre   = Math.pow(1 + semiRPre,  2) - 1;
  const ytmEffPost  = Math.pow(1 + semiRPost, 2) - 1;

  // Per-row data for cash flow table
  const cfRows = futureDates.map((d, i) => {
    const isLast    = i === futureDates.length - 1;
    const tSemi     = daysBetween(settlementDate, d) / daysInPeriod;
    const grossCF   = isLast ? semiCoupon + 100 : semiCoupon;
    const aftTaxCF  = isLast ? afterTaxSemi + 100 : afterTaxSemi;
    const pv        = aftTaxCF / Math.pow(1 + semiRPost, tSemi);
    return { n: i + 1, date: d, tSemi, grossCF, aftTaxCF, pv, isLast };
  });

  const totalPVTable = cfRows.reduce((s, r) => s + r.pv, 0);
  const tFinal       = cfRows[cfRows.length - 1].tSemi;
  const parPV        = 100 / Math.pow(1 + semiRPost, tFinal);
  const couponPVPct  = (totalPVTable - parPV) / dirtyPrice;
  const parPVPct     = parPV / dirtyPrice;

  // ── Render ───────────────────────────────────────────────────────────
  const taxLabel = taxEl.value + '%';

  const gainBadge = capitalGain > 0.005
    ? `<span class="text-green-700 font-medium">${gbp(capitalGain, 2)} gain (tax-free)</span>`
    : capitalGain < -0.005
    ? `<span class="text-red-500 font-medium">${gbp(capitalGain, 2)} loss</span>`
    : `<span class="text-slate-500">At par (£0.00)</span>`;

  const el = document.getElementById('results');
  el.classList.remove('hidden');
  el.innerHTML = `
    <!-- Headline: tax-equivalent yield -->
    <div class="rounded-xl bg-blue-600 text-white p-5">
      <p class="text-xs font-semibold text-blue-200 uppercase tracking-wide mb-1">Tax-Equivalent Gross Rate · ${taxLabel} taxpayer</p>
      <p class="text-4xl font-bold mb-1">${pct(taxEquivYield)}</p>
      <p class="text-sm text-blue-200 leading-snug">
        A fully-taxable investment (e.g. savings account or corporate bond) would need to pay
        <strong class="text-white">${pct(taxEquivYield)}</strong> gross to match this gilt's after-tax return.
        ${taxRate > 0 && capitalGain > 0.5
          ? `The tax-free capital gain of ${gbp(capitalGain, 2)} is grossed up by <strong class="text-white">÷ ${(1 - taxRate).toFixed(2)}</strong>, boosting the equivalent rate above the gross YTM.`
          : ''}
      </p>
    </div>

    <!-- Supporting yields -->
    <div class="grid grid-cols-2 gap-3">
      <div class="rounded-xl bg-slate-50 border border-slate-200 p-4">
        <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Gilt Pre-Tax YTM</p>
        <p class="text-2xl font-bold text-slate-800">${pct(yieldPre)}</p>
        <p class="text-xs text-slate-400 mt-1">Gross effective annualised yield</p>
      </div>
      <div class="rounded-xl bg-slate-50 border border-slate-200 p-4">
        <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Gilt After-Tax YTM</p>
        <p class="text-2xl font-bold text-slate-800">${pct(yieldPost)}</p>
        <p class="text-xs text-slate-400 mt-1">After ${taxLabel} income tax on coupons</p>
      </div>
    </div>

    <!-- Bond details -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Bond Details</h3>
      <div class="space-y-0 divide-y divide-slate-100 text-sm">
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Settlement</span>
          <span class="font-medium text-slate-800">${fmtDate(settlementDate)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Maturity</span>
          <span class="font-medium text-slate-800">${fmtDate(maturityDate)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Years to maturity</span>
          <span class="font-medium text-slate-800">${yearsToMat.toFixed(2)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Next coupon date</span>
          <span class="font-medium text-slate-800">${fmtDate(nextCouponDate)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Remaining coupons</span>
          <span class="font-medium text-slate-800">${futureDates.length}</span>
        </div>
      </div>
    </div>

    <!-- Pricing -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Pricing</h3>
      <div class="space-y-0 divide-y divide-slate-100 text-sm">
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Clean price</span>
          <span class="font-medium text-slate-800">${gbp(cleanPrice)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Accrued interest</span>
          <span class="font-medium text-slate-800">${gbp(accrued)}</span>
        </div>
        <div class="flex justify-between py-2.5 bg-slate-50 -mx-1 px-1 rounded">
          <span class="text-slate-700 font-medium">Dirty price (total outlay)</span>
          <span class="font-bold text-slate-900">${gbp(dirtyPrice)}</span>
        </div>
      </div>
    </div>

    <!-- Return breakdown -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Return Breakdown</h3>
      <div class="space-y-0 divide-y divide-slate-100 text-sm">
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Semi-annual coupon (gross)</span>
          <span class="font-medium text-slate-800">${gbp(semiCoupon)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Semi-annual coupon (after ${taxLabel} tax)</span>
          <span class="font-medium text-slate-800">${gbp(afterTaxSemi)}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Capital gain / loss on maturity</span>
          <span>${gainBadge}</span>
        </div>
        <div class="flex justify-between py-2.5">
          <span class="text-slate-500">Tax drag on yield</span>
          <span class="font-medium text-red-500">−${dragBps.toFixed(0)} bps</span>
        </div>
        ${taxRate > 0 ? `
        <div class="flex justify-between py-2.5 bg-blue-50 -mx-1 px-1 rounded">
          <span class="text-blue-700 font-medium">Tax-equivalent gross rate</span>
          <span class="font-bold text-blue-700">${pct(taxEquivYield)}</span>
        </div>` : ''}
      </div>
    </div>

    ${capitalGain > 0.5 ? `
    <div class="rounded-lg bg-green-50 border border-green-200 p-4 text-sm">
      <p class="font-semibold text-green-800 mb-1">Discount gilt — tax-free gain</p>
      <p class="text-green-700">Trading below par, this gilt delivers ${gbp(capitalGain, 2)} as a tax-free capital gain on redemption. The higher your tax rate, the greater the advantage over an equivalent yield from a taxable source.</p>
    </div>` : ''}

    ${capitalGain < -0.5 ? `
    <div class="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm">
      <p class="font-semibold text-amber-800 mb-1">Premium gilt — capital loss on redemption</p>
      <p class="text-amber-700">Trading above par, the ${gbp(Math.abs(capitalGain), 2)} capital loss at maturity is not tax-deductible. The pre-tax YTM already reflects this, but it cannot be offset against other gains.</p>
    </div>` : ''}

    <!-- Tax treatment of return components -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Tax treatment of return components</h3>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-slate-50 rounded-lg p-4 border border-slate-200">
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm font-semibold text-slate-800">Coupon income</span>
            <span class="text-xs font-medium text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full">Taxed @ ${taxLabel}</span>
          </div>
          <p class="text-xs text-slate-500">Gross: ${(semiCoupon/100).toFixed(4)} per period</p>
          <p class="text-xs text-slate-500 mt-0.5">Net retained: <strong class="text-slate-700">${(afterTaxSemi/100).toFixed(5)} (${(100 - parseFloat(taxEl.value))}%)</strong></p>
        </div>
        <div class="bg-slate-50 rounded-lg p-4 border border-slate-200">
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm font-semibold text-slate-800">Capital appreciation</span>
            <span class="text-xs font-medium text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full">Tax free</span>
          </div>
          <p class="text-xs text-slate-500">Par − dirty price</p>
          <p class="text-xs text-slate-500 mt-0.5">100 − ${dirtyPrice.toFixed(3)} = <strong class="text-slate-700">${capitalGain.toFixed(3)} (100% retained)</strong></p>
        </div>
      </div>
    </div>

    <!-- After-tax cash flows & present values -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">After-tax cash flows &amp; present values</h3>
      <div class="overflow-x-auto -mx-1">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left text-slate-500 font-medium pb-2 pr-2">#</th>
              <th class="text-left text-slate-500 font-medium pb-2 pr-2">Date</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-2">t (periods)</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-2">Gross CF</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-2">After-tax CF</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-2">PV</th>
              <th class="text-right text-slate-500 font-medium pb-2">Weight</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${cfRows.map(r => {
              const weightPct = (r.pv / totalPVTable * 100).toFixed(1);
              const barW = Math.round(r.pv / totalPVTable * 100);
              return `<tr>
                <td class="py-2 pr-2 text-slate-500">${r.n}</td>
                <td class="py-2 pr-2 text-slate-700 whitespace-nowrap">${fmtDate(r.date)}</td>
                <td class="py-2 pr-2 text-right text-slate-700">${r.tSemi.toFixed(4)}</td>
                <td class="py-2 pr-2 text-right text-slate-700">${r.grossCF.toFixed(5)}</td>
                <td class="py-2 pr-2 text-right text-blue-600 font-medium">${r.aftTaxCF.toFixed(5)}</td>
                <td class="py-2 pr-2 text-right text-slate-700">${r.pv.toFixed(5)}</td>
                <td class="py-2 text-right">
                  <div class="flex items-center justify-end gap-1.5">
                    <div class="w-16 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                      <div class="h-1.5 rounded-full ${r.isLast ? 'bg-emerald-600' : 'bg-slate-400'}" style="width:${barW}%"></div>
                    </div>
                    <span class="text-slate-500 w-8 text-right">${weightPct}%</span>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr class="border-t border-slate-200">
              <td colspan="5" class="pt-2 text-right text-slate-500 font-medium">Total PV</td>
              <td class="pt-2 text-right font-bold text-slate-800">${totalPVTable.toFixed(5)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- Return decomposition -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Return decomposition — where yield comes from</h3>
      <p class="text-xs text-slate-500 mb-3">PV of after-tax coupons vs PV of capital gain as % of dirty price</p>
      <div class="relative w-full h-8 rounded-md overflow-hidden flex">
        <div class="h-full bg-blue-600 flex items-center justify-center text-white text-xs font-medium" style="width:${Math.max(couponPVPct * 100, 0).toFixed(1)}%">
          ${couponPVPct >= 0.05 ? (couponPVPct * 100).toFixed(1) + '%' : ''}
        </div>
        <div class="h-full bg-emerald-700 flex items-center justify-center text-white text-xs font-medium flex-1">
          ${(parPVPct * 100).toFixed(1)}%
        </div>
      </div>
      <div class="flex gap-4 mt-2 text-xs text-slate-600">
        <span class="flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-blue-600"></span>After-tax coupons ${(couponPVPct * 100).toFixed(1)}%</span>
        <span class="flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-700"></span>Principal / capital gain ${(parPVPct * 100).toFixed(1)}%</span>
      </div>
    </div>

    <!-- Summary comparison -->
    <div>
      <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Summary comparison</h3>
      <div class="overflow-x-auto -mx-1">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left text-slate-500 font-medium pb-2 pr-3">Measure</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-3">Pre-tax</th>
              <th class="text-right text-slate-500 font-medium pb-2 pr-3">After-tax (${taxLabel} on coupons)</th>
              <th class="text-right text-slate-500 font-medium pb-2">Reduction</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr>
              <td class="py-2 pr-3 text-slate-600">Semi-annual r</td>
              <td class="py-2 pr-3 text-right text-slate-700">${pct(semiRPre, 4)}</td>
              <td class="py-2 pr-3 text-right text-blue-600 font-medium">${pct(semiRPost, 4)}</td>
              <td class="py-2 text-right text-slate-500">${((semiRPre - semiRPost) * 10000).toFixed(2)} bps lower</td>
            </tr>
            <tr>
              <td class="py-2 pr-3 text-slate-600">YTM — bond basis</td>
              <td class="py-2 pr-3 text-right text-slate-700">${pct(ytmBondPre, 3)}</td>
              <td class="py-2 pr-3 text-right text-blue-600 font-medium">${pct(ytmBondPost, 3)}</td>
              <td class="py-2 text-right text-slate-500">${((ytmBondPre - ytmBondPost) * 10000).toFixed(2)} bps lower</td>
            </tr>
            <tr>
              <td class="py-2 pr-3 text-slate-600">YTM — effective annual</td>
              <td class="py-2 pr-3 text-right text-slate-700">${pct(ytmEffPre, 3)}</td>
              <td class="py-2 pr-3 text-right text-blue-600 font-medium">${pct(ytmEffPost, 3)}</td>
              <td class="py-2 text-right text-slate-500">${((ytmEffPre - ytmEffPost) * 10000).toFixed(2)} bps lower</td>
            </tr>
            <tr>
              <td class="py-2 pr-3 text-slate-600">Capital gain (tax-free)</td>
              <td class="py-2 pr-3 text-right text-slate-700">${capitalGain.toFixed(3)}</td>
              <td class="py-2 pr-3 text-right text-blue-600 font-medium">${capitalGain.toFixed(3)}</td>
              <td class="py-2 text-right text-slate-500">unchanged</td>
            </tr>
            <tr>
              <td class="py-2 pr-3 text-slate-600">Coupon per period (net)</td>
              <td class="py-2 pr-3 text-right text-slate-700">${(semiCoupon/100).toFixed(4)}</td>
              <td class="py-2 pr-3 text-right text-blue-600 font-medium">${(afterTaxSemi/100).toFixed(4)}</td>
              <td class="py-2 text-right text-slate-500">${taxLabel} withheld</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
